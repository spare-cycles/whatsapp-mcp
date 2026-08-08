import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeChatsRepo } from "../db/chats.js";
import { openDb } from "../db/client.js";
import { makeContactsRepo } from "../db/contacts.js";
import { AmbiguousRecipientError, RecipientNotFoundError, resolveRecipient } from "./recipient.js";

const dir = mkdtempSync(join(tmpdir(), "whatsapp-recipient-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ALICE = "33611111111@s.whatsapp.net";
const ALICIA = "33622222222@s.whatsapp.net";
const BERNARD = "33633333333@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";

/** The ids an ambiguity refusal printed, in the order it printed them. */
function idsIn(message: string): string[] {
  return [...message.matchAll(/· (\S+)$/gm)].map((m) => m[1] ?? "");
}

/** The error a call threw. `assert.throws` returns undefined, so it cannot check the message too. */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Error, "expected an Error");
    return err;
  }
  assert.fail("expected the call to throw");
}

let n = 0;
function deps(): { chats: ReturnType<typeof makeChatsRepo>; contacts: ReturnType<typeof makeContactsRepo> } {
  const db = openDb(join(dir, `r${n++}.db`));
  return { chats: makeChatsRepo(db), contacts: makeContactsRepo(db) };
}

void test("a JID resolves without consulting the store at all", () => {
  const d = deps();
  assert.equal(resolveRecipient(ALICE, d), ALICE);
  assert.equal(resolveRecipient(GROUP, d), GROUP);
  // Device and agent suffixes are still normalized away, exactly as before this layer existed.
  assert.equal(resolveRecipient("33611111111:12@s.whatsapp.net", d), ALICE);
});

void test("a LID still folds onto the phone identity it is mapped to", () => {
  const d = deps();
  d.contacts.linkIdentity("5551234@lid", ALICE);
  assert.equal(resolveRecipient("5551234@lid", d), ALICE);
});

void test("a phone number written any of the usual ways becomes the same user JID", () => {
  const d = deps();
  for (const written of ["33611111111", "+33611111111", "+33 6 11 11 11 11", "(336) 111-11111"]) {
    assert.equal(resolveRecipient(written, d), ALICE, `"${written}" must resolve to ${ALICE}`);
  }
});

void test("a name with one match resolves to it, from either the chats or the contacts side", () => {
  const d = deps();
  d.chats.ensure(GROUP, true);
  d.chats.patch(GROUP, { name: "Les Copains" });
  // A contact with no chat: someone in the address book who has never been messaged from here.
  d.contacts.upsert({ id: ALICE, name: "Marie Dupont", phoneNumber: "33611111111" });

  assert.equal(resolveRecipient("Les Copains", d), GROUP);
  assert.equal(resolveRecipient("les copains", d), GROUP, "matching is case-insensitive");
  assert.equal(resolveRecipient("Marie Dupont", d), ALICE);
  assert.equal(resolveRecipient("Dupont", d), ALICE, "a substring is enough when it is unambiguous");
});

void test("a person who is both a chat and a contact is one candidate, not two", () => {
  const d = deps();
  d.chats.ensure(ALICE, false);
  d.chats.patch(ALICE, { name: "Marie" });
  d.contacts.upsert({ id: ALICE, name: "Marie", phoneNumber: "33611111111" });
  // Two rows, one human: if the dedupe were missing this would refuse as ambiguous between a chat
  // and a contact that are the same conversation — the most confusing possible refusal.
  assert.equal(resolveRecipient("Marie", d), ALICE);
});

void test("a contact known only by a LID resolves by name to that LID, unfolded", () => {
  const d = deps();
  const lid = "5551234@lid";
  d.contacts.upsert({ id: lid, name: "Marie", lid: "5551234" });
  // No mapping yet, so the LID *is* the identity — the same policy `canonicalId` applies to a JID a
  // caller passes in. Once `linkIdentity` runs, both repositories re-key onto the phone JID and the
  // name resolves there instead, which the test above covers.
  assert.equal(resolveRecipient("Marie", d), lid);
  d.contacts.linkIdentity(lid, ALICE);
  assert.equal(resolveRecipient("Marie", d), ALICE);
});

void test("an ambiguous name is refused, listing the candidates rather than guessing one", () => {
  const d = deps();
  d.contacts.upsert({ id: ALICE, name: "Marie Dupont", phoneNumber: "33611111111" });
  d.contacts.upsert({ id: ALICIA, name: "Marie Curie", phoneNumber: "33622222222" });

  const err = thrown(() => resolveRecipient("Marie", d));
  assert.ok(err instanceof AmbiguousRecipientError, `expected AmbiguousRecipientError, got ${err.name}`);
  assert.match(err.message, /matches 2/);
  assert.match(err.message, /Marie Curie/);
  assert.match(err.message, /Marie Dupont/);
  // The handle it names has to be one the retry can still mean tomorrow: the id, not the position.
  assert.match(err.message, /· 33622222222@s\.whatsapp\.net$/m, "the refusal has to say how to resolve it");
});

void test("the id the refusal prints is what the retry is addressed to", () => {
  const d = deps();
  d.contacts.upsert({ id: ALICE, name: "Marie Dupont", phoneNumber: "33611111111" });
  d.contacts.upsert({ id: ALICIA, name: "Marie Curie", phoneNumber: "33622222222" });

  // Sorted by label, so Curie is listed first and Dupont second.
  const listed = idsIn(thrown(() => resolveRecipient("Marie", d)).message);
  assert.deepEqual(listed, [ALICIA, ALICE]);
  for (const id of listed) assert.equal(resolveRecipient(id, d), id);
});

/**
 * The regression this module was reshaped around.
 *
 * `pick` selected by position into a list re-derived from live SQL on the retry, and the store is
 * written continuously by ingest — `contacts.upsert` off Baileys' `contacts.upsert` event lands
 * between the refusal and the retry all the time. A candidate arriving in that window shifted every
 * later position by one, so the retry the refusal had invited sent a private message to a different
 * human, silently, with a success response. The id is derived from the row rather than from the
 * list, so nothing arriving in the window can move it.
 */
void test("a candidate landing between the refusal and the retry cannot redirect it", () => {
  const d = deps();
  d.contacts.upsert({ id: ALICE, name: "Marie Dupont", phoneNumber: "33611111111" });
  d.contacts.upsert({ id: ALICIA, name: "Marie Curie", phoneNumber: "33622222222" });

  const refusal = thrown(() => resolveRecipient("Marie", d));
  assert.ok(refusal instanceof AmbiguousRecipientError, `expected AmbiguousRecipientError, got ${refusal.name}`);
  const wanted = idsIn(refusal.message)[1];
  assert.equal(wanted, ALICE, "Marie Dupont is the second row the refusal offered");

  // Ingest lands a third Marie, which sorts ahead of both and used to make `pick: 2` mean Curie.
  d.contacts.upsert({ id: BERNARD, name: "Marie Bernard", phoneNumber: "33633333333" });
  assert.deepEqual(idsIn(thrown(() => resolveRecipient("Marie", d)).message), [BERNARD, ALICIA, ALICE]);

  assert.equal(resolveRecipient(wanted, d), ALICE, "the retry must still reach the human the refusal offered");
});

void test("the refusal advertises the id, and offers no positional handle to get wrong", () => {
  const d = deps();
  d.contacts.upsert({ id: ALICE, name: "Marie Dupont", phoneNumber: "33611111111" });
  d.contacts.upsert({ id: ALICIA, name: "Marie Curie", phoneNumber: "33622222222" });

  const message = thrown(() => resolveRecipient("Marie", d)).message;
  assert.match(message, /re-send addressed to the id printed beside the one you want/);
  assert.doesNotMatch(message, /\bpick\b/i, "a positional handle is the thing that raced");
  assert.doesNotMatch(message, /^\d+[).]/m, "and numbering the lines re-advertises it");
});

/**
 * `describeCandidates` caps the list at `LISTED_CANDIDATES`, and the cap used to be a hole rather
 * than a limit: the refusal showed ten rows and told the caller to narrow instead of picking, while
 * `pick: 13` indexed the full unsliced array and resolved to a row that was never displayed. No
 * race needed. Every handle the refusal now offers is one it printed.
 */
void test("with more candidates than it lists, the refusal offers only the ones it printed", () => {
  const d = deps();
  for (let i = 0; i < 14; i++) {
    const suffix = String(i).padStart(2, "0");
    d.contacts.upsert({ id: `336000000${suffix}@s.whatsapp.net`, name: `Marie ${String.fromCharCode(65 + i)}` });
  }

  const message = thrown(() => resolveRecipient("Marie", d)).message;
  const listed = idsIn(message);
  assert.equal(listed.length, 10, "the printed list stays readable");
  assert.match(message, /… and 4 more; narrow the name instead/);
  // Each printed id resolves to exactly the row it was printed for, and nothing else is on offer.
  for (const id of listed) assert.equal(resolveRecipient(id, d), id);
});

void test("an exact name match wins over the longer names it is a prefix of", () => {
  const d = deps();
  d.contacts.upsert({ id: ALICE, name: "Marie", phoneNumber: "33611111111" });
  d.contacts.upsert({ id: ALICIA, name: "Marie-Claire", phoneNumber: "33622222222" });
  // Without this, having a "Marie-Claire" in the address book would make every "send to Marie"
  // ambiguous — which is the common case, not an edge one.
  assert.equal(resolveRecipient("Marie", d), ALICE);
});

void test("two exact matches stay ambiguous — sameness of name is not a tie-break", () => {
  const d = deps();
  d.contacts.upsert({ id: ALICE, name: "Marie", phoneNumber: "33611111111" });
  d.contacts.upsert({ id: ALICIA, name: "Marie", phoneNumber: "33622222222" });
  assert.throws(() => resolveRecipient("Marie", d), AmbiguousRecipientError);
});

void test("a name nothing answers to is refused, and says where to look instead", () => {
  const d = deps();
  const err = thrown(() => resolveRecipient("Nobody", d));
  assert.ok(err instanceof RecipientNotFoundError, `expected RecipientNotFoundError, got ${err.name}`);
  assert.match(err.message, /whatsapp_contacts_search/);
});

void test("a short numeric nickname is a name, not a phone number", () => {
  const d = deps();
  d.chats.ensure(GROUP, true);
  d.chats.patch(GROUP, { name: "2024" });
  assert.equal(resolveRecipient("2024", d), GROUP);
});
