// Typed Firestore path helpers and converters. Feature tracks import these
// instead of building collection paths by hand.
import {
  collection,
  doc,
  CollectionReference,
  DocumentReference,
  FirestoreDataConverter,
  QueryDocumentSnapshot,
} from "firebase/firestore";
import { dbSync } from "./firebase";
import type {
  Project,
  Member,
  Invite,
  Sensor,
  Remote,
  Profile,
  Rule,
  Schedule,
  AlarmEvent,
  UserDoc,
} from "@/types";

// Generic converter: strips `id` on write, injects doc id on read.
function converter<T extends { id: string }>(): FirestoreDataConverter<T> {
  return {
    toFirestore(model) {
      const { id: _id, ...rest } = model as T;
      return rest;
    },
    fromFirestore(snap: QueryDocumentSnapshot) {
      return { id: snap.id, ...snap.data() } as T;
    },
  };
}

const projectConverter = converter<Project>();
const memberConverter = converter<Member>();
const inviteConverter = converter<Invite>();
const sensorConverter = converter<Sensor>();
const remoteConverter = converter<Remote>();
const profileConverter = converter<Profile>();
const ruleConverter = converter<Rule>();
const scheduleConverter = converter<Schedule>();
const eventConverter = converter<AlarmEvent>();
const userConverter = converter<UserDoc>();

export const usersDoc = (email: string) =>
  doc(dbSync(), "users", email.toLowerCase()).withConverter(
    userConverter
  ) as DocumentReference<UserDoc>;

export const projectsCol = () =>
  collection(dbSync(), "projects").withConverter(projectConverter) as CollectionReference<Project>;

export const projectDoc = (projectId: string) =>
  doc(dbSync(), "projects", projectId).withConverter(projectConverter) as DocumentReference<Project>;

export const membersCol = (projectId: string) =>
  collection(dbSync(), "projects", projectId, "members").withConverter(
    memberConverter
  ) as CollectionReference<Member>;

export const memberDoc = (projectId: string, userId: string) =>
  doc(dbSync(), "projects", projectId, "members", userId).withConverter(
    memberConverter
  ) as DocumentReference<Member>;

export const invitesCol = (projectId: string) =>
  collection(dbSync(), "projects", projectId, "invites").withConverter(
    inviteConverter
  ) as CollectionReference<Invite>;

export const inviteDoc = (projectId: string, inviteId: string) =>
  doc(dbSync(), "projects", projectId, "invites", inviteId).withConverter(
    inviteConverter
  ) as DocumentReference<Invite>;

export const sensorsCol = (projectId: string) =>
  collection(dbSync(), "projects", projectId, "sensors").withConverter(
    sensorConverter
  ) as CollectionReference<Sensor>;

export const sensorDoc = (projectId: string, sensorId: string) =>
  doc(dbSync(), "projects", projectId, "sensors", sensorId).withConverter(
    sensorConverter
  ) as DocumentReference<Sensor>;

export const remotesCol = (projectId: string) =>
  collection(dbSync(), "projects", projectId, "remotes").withConverter(
    remoteConverter
  ) as CollectionReference<Remote>;

export const remoteDoc = (projectId: string, remoteId: string) =>
  doc(dbSync(), "projects", projectId, "remotes", remoteId).withConverter(
    remoteConverter
  ) as DocumentReference<Remote>;

export const profilesCol = (projectId: string) =>
  collection(dbSync(), "projects", projectId, "profiles").withConverter(
    profileConverter
  ) as CollectionReference<Profile>;

export const profileDoc = (projectId: string, profileId: string) =>
  doc(dbSync(), "projects", projectId, "profiles", profileId).withConverter(
    profileConverter
  ) as DocumentReference<Profile>;

export const rulesCol = (projectId: string, profileId: string) =>
  collection(dbSync(), "projects", projectId, "profiles", profileId, "rules").withConverter(
    ruleConverter
  ) as CollectionReference<Rule>;

export const ruleDoc = (projectId: string, profileId: string, ruleId: string) =>
  doc(dbSync(), "projects", projectId, "profiles", profileId, "rules", ruleId).withConverter(
    ruleConverter
  ) as DocumentReference<Rule>;

export const schedulesCol = (projectId: string) =>
  collection(dbSync(), "projects", projectId, "schedules").withConverter(
    scheduleConverter
  ) as CollectionReference<Schedule>;

export const scheduleDoc = (projectId: string, scheduleId: string) =>
  doc(dbSync(), "projects", projectId, "schedules", scheduleId).withConverter(
    scheduleConverter
  ) as DocumentReference<Schedule>;

export const eventsCol = (projectId: string) =>
  collection(dbSync(), "projects", projectId, "events").withConverter(
    eventConverter
  ) as CollectionReference<AlarmEvent>;
