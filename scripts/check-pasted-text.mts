import assert from "node:assert/strict";
import {
  LONG_PASTE_MIN_BYTES,
  hasUtf8BytesAtLeast,
  pastedTextFilename,
  shouldPromotePastedText,
  utf8ByteLength,
} from "../web/src/dashboard/session/composer/pasted-text.ts";
import { parseMessageAttachments } from "../web/src/files/MessageAttachments-helpers.ts";

assert.equal(utf8ByteLength("plain"), 5);
assert.equal(utf8ByteLength("界"), 3);
assert.equal(hasUtf8BytesAtLeast("界".repeat(683), LONG_PASTE_MIN_BYTES), true);
assert.equal(shouldPromotePastedText("x".repeat(LONG_PASTE_MIN_BYTES - 1)), false);
assert.equal(shouldPromotePastedText("x".repeat(LONG_PASTE_MIN_BYTES)), true);
assert.equal(shouldPromotePastedText(" \n".repeat(LONG_PASTE_MIN_BYTES)), false);
assert.equal(
  shouldPromotePastedText("界".repeat(Math.ceil(LONG_PASTE_MIN_BYTES / 3))),
  true,
  "non-ASCII pastes use their real encoded size",
);

assert.equal(pastedTextFilename("ABC-def_1234-XYZ"), "pasted-text-abcdef1234xy.txt");
assert.equal(pastedTextFilename("---"), "pasted-text-draft.txt");

const parsed = parseMessageAttachments(
  "Summarize this\n\n" +
  "[Attached 1 file(s) in ./uploads/: uploads/pasted-text-abcdef1234xy.txt]\n" +
  "Use read_file to read the pasted text before responding: uploads/pasted-text-abcdef1234xy.txt.",
);
assert.equal(parsed.cleanText, "Summarize this");
assert.deepEqual(parsed.files, [{
  path: "uploads/pasted-text-abcdef1234xy.txt",
  name: "pasted-text-abcdef1234xy.txt",
  isImage: false,
}]);

console.log("check-pasted-text: all assertions passed");
