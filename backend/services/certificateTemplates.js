/**
 * Certificate field contract — the single source of truth.
 *
 * The 17 base fields come from the NOSIH spec. Both the Gemini prompt
 * text and the API responseSchema are DERIVED from these descriptions, so a
 * field cannot be described one way to the model and enforced another.
 *
 * Different certificate categories carry different extra fields. Templates
 * extend the base schema dynamically; extracted extras are persisted in
 * certificates.extra_data (JSONB) and rendered in the review form.
 */

// ── Base fields (every certificate) ───────────────────────

export const CERTIFICATE_FIELDS = [
  "certificateType",
  "certificateNumber",
  "holderName",
  "holderIdentifier",
  "institutionName",
  "institutionAddress",
  "courseName",
  "qualification",
  "qualificationLevel",
  "specialization",
  "grade",
  "percentage",
  "issueDate",
  "expiryDate",
  "academicYear",
  "signatoryName",
  "signatoryDesignation",
];

export const FIELD_DESCRIPTIONS = {
  certificateType: "One of: undergraduate_degree, postgraduate_degree, diploma, transcript, professional_training, technical_certification, course_completion, internship, achievement, other",
  certificateNumber: "Certificate / serial / credential number exactly as printed, including letters, digits, slashes and dashes",
  holderName: "Full name of the person the certificate is awarded to, original spelling preserved",
  holderIdentifier: "Student roll / registration / enrollment number of the holder (empty if not printed)",
  institutionName: "Name of the issuing institution / university / organization exactly as printed",
  institutionAddress: "Address of the issuing institution as printed on the certificate",
  courseName: "Course / programme / training name",
  qualification: "Qualification awarded, e.g. Bachelor of Science, Diploma in Mechanical Engineering",
  qualificationLevel: "Level of the qualification, e.g. undergraduate, postgraduate, doctoral, professional",
  specialization: "Specialization / major / branch / stream",
  grade: "Grade / class / division exactly as stated, e.g. First Class with Distinction, A+",
  percentage: "Numeric percentage only, no % sign, e.g. 87.5",
  issueDate: "Date of issue / award / convocation, normalized to YYYY-MM-DD",
  expiryDate: "Expiry / validity-end date, normalized to YYYY-MM-DD (empty if the certificate does not expire)",
  academicYear: "Academic year / session / batch, e.g. 2023-2024",
  signatoryName: "Name of the signatory (registrar, director, principal, controller of examinations)",
  signatoryDesignation: "Designation of the signatory as printed",
};

export const CERTIFICATE_TYPES = [
  "undergraduate_degree",
  "postgraduate_degree",
  "diploma",
  "transcript",
  "professional_training",
  "technical_certification",
  "course_completion",
  "internship",
  "achievement",
  "other",
];

// ── Dynamic templates: extra fields per certificate type ──

export const CERTIFICATE_TEMPLATES = {
  undergraduate_degree: {
    label: "Undergraduate degree",
    extraFields: {
      universityRegistrationNumber: "University registration / enrollment number of the holder",
      degreeClass: "Class / division awarded, e.g. First Class",
      convocationDate: "Convocation date, YYYY-MM-DD",
      cgpa: "CGPA / GPA exactly as stated, e.g. 8.7",
    },
  },
  postgraduate_degree: {
    label: "Postgraduate degree",
    extraFields: {
      universityRegistrationNumber: "University registration / enrollment number of the holder",
      thesisTitle: "Thesis / dissertation title if printed",
      degreeClass: "Class / division awarded",
      convocationDate: "Convocation date, YYYY-MM-DD",
      cgpa: "CGPA / GPA exactly as stated",
    },
  },
  diploma: {
    label: "Diploma",
    extraFields: {
      trade: "Trade / discipline of the diploma",
      duration: "Programme duration as stated, e.g. 3 years",
      board: "Examining board / council name",
    },
  },
  transcript: {
    label: "Academic transcript",
    extraFields: {
      semesterCount: "Number of semesters covered",
      totalCredits: "Total credits earned",
      cgpa: "Cumulative GPA / CGPA",
      gradingScale: "Grading scale, e.g. 10-point",
    },
  },
  professional_training: {
    label: "Professional training",
    extraFields: {
      trainingProvider: "Training provider name",
      trainingHours: "Training duration in hours",
      cpdPoints: "CPD / CEU points awarded",
      assessmentResult: "Assessment result, e.g. Pass",
    },
  },
  technical_certification: {
    label: "Technical certification",
    extraFields: {
      vendor: "Certifying vendor / body, e.g. AWS, Cisco",
      certificationLevel: "Certification level, e.g. Associate, Professional",
      credentialId: "Credential / verification ID",
      validFrom: "Validity start date, YYYY-MM-DD",
    },
  },
  course_completion: {
    label: "Course completion",
    extraFields: {
      platform: "Learning platform name",
      courseDuration: "Course duration as stated",
      completionScore: "Completion score if stated",
    },
  },
  internship: {
    label: "Internship",
    extraFields: {
      hostOrganization: "Host organization name",
      internshipRole: "Intern role / position",
      startDate: "Internship start date, YYYY-MM-DD",
      endDate: "Internship end date, YYYY-MM-DD",
      durationWeeks: "Duration in weeks",
      supervisorName: "Supervisor / mentor name",
    },
  },
  achievement: {
    label: "Achievement / award",
    extraFields: {
      eventName: "Event / competition name",
      achievementRank: "Rank / position / award title",
      awardingBody: "Awarding body name",
      eventDate: "Event date, YYYY-MM-DD",
    },
  },
  other: { label: "Other certificate", extraFields: {} },
};

/** Template for a type string; unknown types fall back to "other". */
export function templateFor(certificateType) {
  return CERTIFICATE_TEMPLATES[certificateType] ?? CERTIFICATE_TEMPLATES.other;
}

// ── Derived schemas ───────────────────────────────────────

/** The base schema as the prompt shows it. */
export const FIELD_SPEC = `{\n${CERTIFICATE_FIELDS.map(
  (key) => `  "${key}": ${JSON.stringify(FIELD_DESCRIPTIONS[key] ?? "")}`
).join(",\n")}\n}`;

/**
 * The base schema as the API enforces it, plus per-field confidence,
 * per-field supporting fragments, and the list of inferred fields.
 * responseMimeType + responseSchema make the shape a property of the call;
 * the parser still coerces and validates the values.
 */
export function buildBaseResponseSchema() {
  return {
    type: "object",
    properties: {
      ...Object.fromEntries(
        CERTIFICATE_FIELDS.map((key) => [key, { type: "string", description: FIELD_DESCRIPTIONS[key] ?? "" }])
      ),
      fieldConfidence: {
        type: "object",
        description: "Per-field confidence from 0 (absent/unsure) to 1 (clearly printed)",
        properties: Object.fromEntries(CERTIFICATE_FIELDS.map((key) => [key, { type: "number" }])),
        required: [...CERTIFICATE_FIELDS],
      },
      fieldEvidence: {
        type: "object",
        description: "Per-field verbatim supporting text fragment from the document (empty when the field is empty)",
        properties: Object.fromEntries(CERTIFICATE_FIELDS.map((key) => [key, { type: "string" }])),
        required: [...CERTIFICATE_FIELDS],
      },
      inferredFields: {
        type: "array",
        description: "Names of fields whose value was inferred from context rather than explicitly stated",
        items: { type: "string" },
      },
    },
    required: [...CERTIFICATE_FIELDS, "fieldConfidence", "fieldEvidence", "inferredFields"],
    propertyOrdering: [...CERTIFICATE_FIELDS, "fieldConfidence", "fieldEvidence", "inferredFields"],
  };
}

/** Response schema for a template's extra fields (second, targeted call). */
export function buildExtraFieldsSchema(extraFields) {
  const keys = Object.keys(extraFields);
  return {
    type: "object",
    properties: {
      ...Object.fromEntries(keys.map((key) => [key, { type: "string", description: extraFields[key] }])),
      fieldConfidence: {
        type: "object",
        properties: Object.fromEntries(keys.map((key) => [key, { type: "number" }])),
        required: keys,
      },
    },
    required: [...keys, "fieldConfidence"],
    propertyOrdering: [...keys, "fieldConfidence"],
  };
}

/**
 * The extraction rules, shared by every model call so digital text and OCR
 * text are held to the same contract.
 */
export const SCHEMA_RULES = `The values must satisfy these rules:
- Every key is present. A field that is not stated is an empty string "".
- NEVER guess, invent or complete a value from world knowledge. If it is not in the text, it is "".
- Preserve the original spelling of names and the exact certificate numbers (letters, digits, slashes, dashes).
- Dates are normalized to YYYY-MM-DD. If only a year is stated, the date field stays "" and the year may go to academicYear when appropriate.
- "percentage" is a number with no % sign and no thousands separator.
- "certificateType" is one of: ${CERTIFICATE_TYPES.join(", ")}. Choose "other" when none fits.
- fieldConfidence: 0 when the field is empty; otherwise 0..1 reflecting how clearly the text supports the value.
- fieldEvidence: a SHORT verbatim fragment (max 200 characters) copied from the document text that supports the value; "" when the field is empty.
- inferredFields: list a field name ONLY when its value was inferred from context (e.g. qualificationLevel from the degree name) rather than explicitly stated. Explicitly printed fields are never listed.

Return ONLY the JSON object. No markdown, no explanation.`;