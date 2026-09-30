const SCALE = 1_000_000;
const EARTH_RADIUS_METERS = 6_371_008.8;
const REORDER_WINDOW_MS = 10 * 60 * 1_000;

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("value is outside canonical JSON");
}

function integerCoordinate(value) {
  if (!Number.isFinite(value) || !/^-?\d+(?:\.\d{1,6})?$/u.test(String(value))) throw new TypeError("coordinate requires at most six fractional digits");
  return BigInt(Math.round(value * SCALE));
}

function pointPair(value) {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError("polygon point must be [longitude,latitude]");
  const [longitude, latitude] = value;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) throw new TypeError("coordinate out of range");
  return [integerCoordinate(longitude), integerCoordinate(latitude)];
}

function samePoint(left, right) { return left[0] === right[0] && left[1] === right[1]; }

function orientation(a, b, c) {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return value === 0n ? 0 : value > 0n ? 1 : -1;
}

function onSegment(point, start, end) {
  return orientation(start, end, point) === 0
    && point[0] >= (start[0] < end[0] ? start[0] : end[0])
    && point[0] <= (start[0] > end[0] ? start[0] : end[0])
    && point[1] >= (start[1] < end[1] ? start[1] : end[1])
    && point[1] <= (start[1] > end[1] ? start[1] : end[1]);
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (abC !== abD && cdA !== cdB) return true;
  return (abC === 0 && onSegment(c, a, b))
    || (abD === 0 && onSegment(d, a, b))
    || (cdA === 0 && onSegment(a, c, d))
    || (cdB === 0 && onSegment(b, c, d));
}

export function isValidPolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 4 || polygon.length > 10_001) return { ok: false, code: "RING_CARDINALITY" };
  let points;
  try { points = polygon.map(pointPair); }
  catch (error) { return { ok: false, code: "INVALID_COORDINATE", message: error.message }; }
  if (!samePoint(points[0], points.at(-1))) return { ok: false, code: "RING_NOT_CLOSED" };
  for (let index = 0; index < points.length - 1; index += 1) {
    if (samePoint(points[index], points[index + 1])) return { ok: false, code: "DUPLICATE_VERTEX" };
    if (Math.abs(polygon[index + 1][0] - polygon[index][0]) > 180) return { ok: false, code: "ANTIMERIDIAN" };
  }
  const segmentCount = points.length - 1;
  for (let left = 0; left < segmentCount; left += 1) {
    for (let right = left + 1; right < segmentCount; right += 1) {
      if (right === left + 1 || (left === 0 && right === segmentCount - 1)) continue;
      if (segmentsIntersect(points[left], points[left + 1], points[right], points[right + 1])) return { ok: false, code: "SELF_INTERSECTION" };
    }
  }
  return { ok: true };
}

function insidePolygon(points, point) {
  let inside = false;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (onSegment(point, start, end)) return "BOUNDARY";
    if ((start[1] > point[1]) === (end[1] > point[1])) continue;
    const left = (end[0] - start[0]) * (point[1] - start[1]);
    const right = (point[0] - start[0]) * (end[1] - start[1]);
    const crossesRight = end[1] > start[1] ? left > right : left < right;
    if (crossesRight) inside = !inside;
  }
  return inside ? "INSIDE" : "OUTSIDE";
}

function segmentDistanceMeters(point, start, end) {
  const radians = Math.PI / 180;
  const meanLatitude = ((point.latitude + start[1] + end[1]) / 3) * radians;
  const project = ([longitude, latitude]) => ({
    x: (longitude - point.longitude) * radians * EARTH_RADIUS_METERS * Math.cos(meanLatitude),
    y: (latitude - point.latitude) * radians * EARTH_RADIUS_METERS,
  });
  const a = project(start);
  const b = project(end);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denominator = dx * dx + dy * dy;
  const ratio = denominator === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / denominator));
  return Math.hypot(a.x + ratio * dx, a.y + ratio * dy);
}

export function classifyPoint(polygon, point) {
  const validity = isValidPolygon(polygon);
  if (!validity.ok) throw new TypeError(`invalid polygon: ${validity.code}`);
  if (!point || point.longitude < -180 || point.longitude > 180 || point.latitude < -90 || point.latitude > 90) throw new TypeError("invalid query point");
  const scaled = polygon.map(pointPair);
  const target = [integerCoordinate(point.longitude), integerCoordinate(point.latitude)];
  const state = insidePolygon(scaled, target);
  const distanceMeters = state === "BOUNDARY"
    ? 0
    : Math.min(...polygon.slice(0, -1).map((start, index) => segmentDistanceMeters(point, start, polygon[index + 1])));
  return { state, distanceMeters, signedDistanceMeters: state === "INSIDE" ? distanceMeters : state === "OUTSIDE" ? -distanceMeters : 0 };
}

export function effectiveVersion(versions, at) {
  const instant = Date.parse(at);
  if (!Number.isFinite(instant)) throw new TypeError("at must be an ISO timestamp");
  const active = versions.filter((version) => {
    const from = Date.parse(version.effectiveFrom);
    const to = version.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(version.effectiveTo);
    return from <= instant && instant < to;
  });
  if (active.length !== 1) throw new Error(`expected one active RegionVersion, found ${active.length}`);
  return active[0];
}

function canonicalOrder(left, right) {
  return Date.parse(left.observedAt) - Date.parse(right.observedAt)
    || left.deviceSequence - right.deviceSequence
    || left.eventId.localeCompare(right.eventId);
}

export function projectTimeline(events, regionVersion) {
  const ordered = [...events].sort(canonicalOrder);
  const transitions = [];
  let membership;
  let insideInterval = false;
  let enteredAt = null;
  let dwellEmitted = false;
  let watermark = null;
  const emit = (type, event) => transitions.push({
    tenantId: event.tenantId,
    deviceId: event.deviceId,
    regionId: regionVersion.regionId,
    regionVersionId: regionVersion.regionVersionId,
    type,
    observedAt: event.observedAt,
    sourceEventId: event.eventId,
    sequence: transitions.length + 1,
  });
  for (const event of ordered) {
    const classified = classifyPoint(regionVersion.polygon, event);
    const tolerance = regionVersion.boundaryToleranceMeters;
    const state = Math.abs(classified.signedDistanceMeters) <= tolerance
      ? "BOUNDARY"
      : classified.state;
    if (!insideInterval && classified.signedDistanceMeters > tolerance) {
      insideInterval = true;
      enteredAt = event.observedAt;
      dwellEmitted = false;
      emit("ENTER", event);
    } else if (insideInterval && classified.signedDistanceMeters < -tolerance) {
      emit("EXIT", event);
      insideInterval = false;
      enteredAt = null;
      dwellEmitted = false;
    } else if (insideInterval && !dwellEmitted && classified.signedDistanceMeters > 0
      && Date.parse(event.observedAt) - Date.parse(enteredAt) >= regionVersion.dwellSeconds * 1_000) {
      emit("DWELL", event);
      dwellEmitted = true;
    }
    watermark = watermark === null || Date.parse(event.observedAt) > Date.parse(watermark) ? event.observedAt : watermark;
    membership = {
      tenantId: event.tenantId,
      deviceId: event.deviceId,
      regionId: regionVersion.regionId,
      regionVersionId: regionVersion.regionVersionId,
      state,
      enteredAt: insideInterval ? enteredAt : null,
      lastObservedAt: event.observedAt,
      lastDeviceSequence: event.deviceSequence,
      watermark,
      revision: (membership?.revision ?? 0) + 1,
    };
  }
  return { membership: membership ?? null, transitions, watermark };
}

export function replayArrivals(arrivals, regionVersion, windowMs = REORDER_WINDOW_MS) {
  const accepted = [];
  const lateIgnored = [];
  let watermark;
  let projection = projectTimeline([], regionVersion);
  for (const event of arrivals) {
    const observed = Date.parse(event.observedAt);
    if (watermark !== undefined && observed < watermark - windowMs) {
      lateIgnored.push(event);
      continue;
    }
    accepted.push(event);
    watermark = watermark === undefined ? observed : Math.max(watermark, observed);
    projection = projectTimeline(accepted, regionVersion);
  }
  return { projection, accepted: [...accepted].sort(canonicalOrder), lateIgnored, watermark: watermark === undefined ? null : new Date(watermark).toISOString() };
}

export function assertContiguousTransitions(transitions) {
  const groups = new Map();
  for (const transition of transitions) {
    const key = `${transition.deviceId}\0${transition.regionId}`;
    const values = groups.get(key) ?? [];
    values.push(transition);
    groups.set(key, values);
  }
  for (const [key, values] of groups) {
    const ordered = [...values].sort((left, right) => left.sequence - right.sequence);
    const expected = Array.from({ length: ordered.length }, (_, index) => index + 1);
    if (canonicalJson(ordered.map(({ sequence }) => sequence)) !== canonicalJson(expected)) throw new Error(`Transition sequence is not contiguous for ${key}`);
    if (new Set(ordered.map(({ sourceEventId, type }) => `${sourceEventId}\0${type}`)).size !== ordered.length) throw new Error(`Transition source/type is duplicated for ${key}`);
  }
  return { groups: groups.size, transitions: transitions.length };
}

export function assertEventLedger(events) {
  const identities = new Map();
  const groups = new Map();
  for (const event of events) {
    const body = canonicalJson(event.body ?? event.payload ?? {});
    if (identities.has(event.eventId) && identities.get(event.eventId) !== body) throw new Error(`Event ${event.eventId} changed body`);
    identities.set(event.eventId, body);
    const values = groups.get(event.aggregateId) ?? [];
    values.push(event.sequence);
    groups.set(event.aggregateId, values);
  }
  for (const [aggregateId, sequences] of groups) {
    const distinct = [...new Set(sequences)].sort((left, right) => left - right);
    const expected = Array.from({ length: distinct.at(-1) ?? 0 }, (_, index) => index + 1);
    if (canonicalJson(distinct) !== canonicalJson(expected)) throw new Error(`Event sequence is not contiguous for ${aggregateId}`);
  }
  return { events: identities.size, aggregates: groups.size };
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0 || fraction < 0 || fraction > 1) throw new TypeError("invalid percentile input");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

export { REORDER_WINDOW_MS };
