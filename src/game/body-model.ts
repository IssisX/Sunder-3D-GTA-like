// Compatibility facade for the canonical humanoid substrate.
//
// New code should import the narrow owner it needs from ./human/*.
// Existing callers keep this barrel during migration so extraction does not
// create a repository-wide churn or a second body authority.
export * from "./human/anatomy";
export * from "./human/rig-state";
export * from "./human/base-pose";
