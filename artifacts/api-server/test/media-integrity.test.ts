import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assessMediaIntegrityFailure,
  mediaIntegritySummary,
} from "../src/services/media-integrity";

describe("media integrity classification", () => {
  test("classifies common container damage signatures as media integrity failures", () => {
    const examples = [
      "Invalid Matroska EBML header",
      "EBML header parsing failed",
      "[mov,mp4,m4a,3gp,3g2,mj2] moov atom not found",
      "Invalid data found when processing input",
      "Unexpected EOF while reading header",
      "End of file",
      "Could not find codec parameters for stream 0",
      "Error parsing container header",
    ];

    for (const message of examples) {
      assert.equal(
        assessMediaIntegrityFailure(message).classification,
        "corrupt_or_malformed_container",
        message,
      );
    }
  });

  test("keeps operational inspection failures separate from media damage", () => {
    const assessment = assessMediaIntegrityFailure(
      "spawn C:\\tools\\ffprobe.exe EACCES",
    );
    assert.equal(assessment.classification, "inspection_unavailable");
    assert.match(assessment.summary, /operational error/i);
  });

  test("provides stable human-readable summaries", () => {
    assert.match(
      mediaIntegritySummary("corrupt_or_malformed_container") ?? "",
      /corrupt or malformed/i,
    );
    assert.match(
      mediaIntegritySummary("inspection_unavailable") ?? "",
      /could not be inspected/i,
    );
    assert.equal(mediaIntegritySummary(null), null);
  });
});