// Pure provisioning-decision logic, separated from Firestore I/O so it can be
// unit-tested. Given whether the /users collection is empty and whether this
// user already has a doc, decide what to do on login.

export type ProvisionDecision =
  | { action: "bootstrap" } // first user ever → create as system admin
  | { action: "allow" } // known user → let them in
  | { action: "deny" }; // uninvited → reject, write nothing

export function decideProvision(input: {
  usersCollectionEmpty: boolean;
  userDocExists: boolean;
}): ProvisionDecision {
  if (input.usersCollectionEmpty) return { action: "bootstrap" };
  if (input.userDocExists) return { action: "allow" };
  return { action: "deny" };
}
