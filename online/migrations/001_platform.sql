create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

CREATE TABLE workspaces (
  owner_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL,
  write_token TEXT
);

CREATE TABLE entries (
  owner_id TEXT NOT NULL REFERENCES workspaces(owner_id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (owner_id, collection, id)
);

CREATE TABLE assets (
  owner_id TEXT NOT NULL REFERENCES workspaces(owner_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  PRIMARY KEY (owner_id, name),
  UNIQUE (object_key)
);
