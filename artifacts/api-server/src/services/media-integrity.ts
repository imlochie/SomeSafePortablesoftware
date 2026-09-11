export type MediaIntegrityClassification =
  | "corrupt_or_malformed_container"
  | "inspection_unavailable";

export type MediaIntegrityAssessment = {
  classification: MediaIntegrityClassification;
  summary: string;
};

export type MediaIntegrityFailureSource = "ffprobe" | "operational";

const containerFailurePatterns = [
  /invalid\s+(?:matroska|ebml)\s+header/i,
  /(?:invalid|failed|error|unable)\s+(?:to\s+)?(?:read|parse|process)?\s*(?:the\s+)?(?:matroska\s+)?ebml(?:\s+(?:header|element|data))?/i,
  /(?:matroska|ebml)\s+(?:header|element|data)\s+(?:read|parse|parsing|processing)\s+(?:failed|error|invalid)/i,
  /invalid\s+data\s+found\s+when\s+processing\s+input/i,
  /moov\s+atom\s+not\s+found/i,
  /end[\s-]*of[\s-]*file/i,
  /unexpected\s+(?:end[\s-]*of[\s-]*file|eof)/i,
  /(?:could\s+not|failed\s+to|error\s+(?:while\s+)?|unable\s+to)\s+(?:read|parse)\s+(?:the\s+)?header/i,
  /could\s+not\s+find\s+codec\s+parameters/i,
  /error\s+parsing\s+(?:header|container|format)/i,
  /\b(?:truncated|corrupt|malformed)\s+(?:file|container|header|stream|input|media)?/i,
  /file\s+is\s+truncated/i,
];

export function assessMediaIntegrityFailure(
  rawError: string,
  source: MediaIntegrityFailureSource = "ffprobe",
): MediaIntegrityAssessment {
  if (source === "ffprobe" && containerFailurePatterns.some((pattern) => pattern.test(rawError))) {
    return {
      classification: "corrupt_or_malformed_container",
      summary: "FFprobe found a corrupt or malformed media container.",
    };
  }

  return {
    classification: "inspection_unavailable",
    summary: "The media file could not be inspected because of an operational error.",
  };
}

export function mediaIntegritySummary(classification: MediaIntegrityClassification | null) {
  if (classification === "corrupt_or_malformed_container") {
    return "FFprobe found a corrupt or malformed media container.";
  }
  if (classification === "inspection_unavailable") {
    return "The media file could not be inspected because of an operational error.";
  }
  return null;
}