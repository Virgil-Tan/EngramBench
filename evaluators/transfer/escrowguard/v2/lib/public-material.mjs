import assert from "node:assert/strict";

const DATABASE_URL = /\bpostgres(?:ql)?:\/\//iu;
const POSIX_PRIVATE_PATH = /(?<![A-Za-z0-9._-])\/(?:Users|home|tmp|workspace|private|opt|root|srv|mnt|etc|usr|bin|sbin|lib(?:64)?|proc|sys|dev|run|Applications|Library)(?:\/[^\s"'<>]*)?(?=$|[\s"'<>])/iu;
const POSIX_DATA_DESCENDANT = /(?<![A-Za-z0-9._-])\/data\/[^\s"'<>]+/iu;
const POSIX_VAR_PRIVATE_PATH = /(?<![A-Za-z0-9._-])\/var(?:\/(?:folders|tmp|lib|run|log)(?:\/[^\s"'<>]*)?)?(?=$|[\s"'<>])/iu;
const WINDOWS_PRIVATE_PATH = /(?<![A-Za-z0-9._-])[A-Za-z]:\\+(?:Users|home|tmp|workspace|data|private|opt|root|srv|mnt|Windows|Program Files)(?:\\+[^\s"'<>]*)?(?=$|[\s"'<>])/iu;

export function containsPrivatePath(value) {
  const text = String(value ?? "");
  return DATABASE_URL.test(text) || POSIX_PRIVATE_PATH.test(text) || POSIX_DATA_DESCENDANT.test(text) || POSIX_VAR_PRIVATE_PATH.test(text) || WINDOWS_PRIVATE_PATH.test(text);
}

export function assertNoPrivatePaths(value, label = "public material") {
  assert.equal(containsPrivatePath(value), false, `${label} omits private database URLs and absolute filesystem paths`);
}
