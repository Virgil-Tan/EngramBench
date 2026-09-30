export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("ClinicGrid canonical JSON accepts safe integers only");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("value is outside RFC 8785 domain");
}

export function interval(startAt, durationMinutes) {
  const start = Date.parse(startAt);
  if (!Number.isFinite(start) || !Number.isSafeInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 240 || durationMinutes % 15 !== 0) throw new TypeError("invalid Appointment interval");
  if (new Date(start).getUTCMinutes() % 15 !== 0 || new Date(start).getUTCSeconds() !== 0 || new Date(start).getUTCMilliseconds() !== 0) throw new TypeError("startAt is not aligned to 15 minutes");
  return { startAt: new Date(start).toISOString(), endAt: new Date(start + durationMinutes * 60_000).toISOString() };
}

export function overlaps(left, right) {
  return Date.parse(left.startAt) < Date.parse(right.endAt) && Date.parse(right.startAt) < Date.parse(left.endAt);
}

export function covers(availability, target) {
  return availability.some((item) => Date.parse(item.startAt) <= Date.parse(target.startAt) && Date.parse(item.endAt) >= Date.parse(target.endAt));
}

function ordered(resources, idField) {
  return [...resources].sort((left, right) => left.priority - right.priority || left[idField].localeCompare(right[idField]));
}

export function selectResources({ seed, request, activeAppointments = [] }) {
  const service = seed.serviceTypes.find(({ serviceTypeId }) => serviceTypeId === request.serviceTypeId);
  const clinician = seed.clinicians.find(({ clinicianId }) => clinicianId === request.clinicianId);
  if (!service || !clinician) return null;
  const target = interval(request.startAt, service.durationMinutes);
  const busy = (field, id) => activeAppointments.some((appointment) => ["HELD", "CONFIRMED"].includes(appointment.state)
    && (Array.isArray(appointment[field]) ? appointment[field].includes(id) : appointment[field] === id) && overlaps(appointment, target));
  if (!covers(clinician.availability, target) || busy("clinicianId", clinician.clinicianId)) return null;
  const room = ordered(seed.rooms, "roomId").find((item) => covers(item.availability, target) && !busy("roomId", item.roomId));
  if (!room) return null;
  const equipmentUnitIds = [];
  for (const type of service.requiredEquipmentTypes) {
    const unit = ordered(seed.equipmentUnits.filter(({ equipmentType }) => equipmentType === type), "equipmentUnitId")
      .find((item) => covers(item.availability, target) && !busy("equipmentUnitIds", item.equipmentUnitId) && !equipmentUnitIds.includes(item.equipmentUnitId));
    if (!unit) return null;
    equipmentUnitIds.push(unit.equipmentUnitId);
  }
  return { clinicianId: clinician.clinicianId, roomId: room.roomId, equipmentUnitIds, ...target };
}

export function planAggregate(visits, explicitlyTerminated = false) {
  const states = visits.map(({ appointment }) => appointment.state);
  const terminal = explicitlyTerminated || states.some((state) => ["CANCELLED", "EXPIRED"].includes(state));
  const state = terminal ? "TERMINATED"
    : states.every((value) => value === "CONFIRMED") ? "CONFIRMED"
      : states.some((value) => value === "CONFIRMED") ? "PARTIALLY_CONFIRMED" : "HELD";
  const heldExpiries = visits.filter(({ appointment }) => appointment.state === "HELD").map(({ appointment }) => appointment.expiresAt).sort();
  return { state, expiresAt: heldExpiries[0] ?? null };
}

export function terminatePlan(visits, terminalAt) {
  return visits.map((visit) => ({
    ...structuredClone(visit),
    appointment: {
      ...structuredClone(visit.appointment),
      state: visit.appointment.state === "CONFIRMED" ? "CONFIRMED" : "CANCELLED",
      terminalAt: visit.appointment.state === "CONFIRMED" ? visit.appointment.terminalAt ?? null : terminalAt,
    },
  }));
}

export function sortWaitlist(entries) {
  return [...entries].sort((left, right) => right.priority - left.priority
    || Date.parse(left.joinedAt) - Date.parse(right.joinedAt)
    || left.waitlistEntryId.localeCompare(right.waitlistEntryId));
}

export function assertCalendarExclusivity(appointments) {
  const calendars = new Map();
  const active = appointments.filter(({ state }) => ["HELD", "CONFIRMED"].includes(state));
  for (const appointment of active) {
    const resources = [`clinician:${appointment.clinicianId}`, `room:${appointment.roomId}`, ...appointment.equipmentUnitIds.map((id) => `equipment:${id}`)];
    for (const resource of resources) {
      const values = calendars.get(resource) ?? [];
      for (const existing of values) if (overlaps(existing, appointment)) throw new Error(`${resource} has overlapping Appointments`);
      values.push(appointment);
      calendars.set(resource, values);
    }
  }
  return { resources: calendars.size, activeAppointments: active.length };
}

export function assertCompleteBundles(snapshot) {
  const resources = snapshot.resources;
  const services = new Map(resources.serviceTypes.map((item) => [item.serviceTypeId, item]));
  const rooms = new Set(resources.rooms.map(({ roomId }) => roomId));
  const clinicians = new Set(resources.clinicians.map(({ clinicianId }) => clinicianId));
  const equipment = new Map(resources.equipmentUnits.map((item) => [item.equipmentUnitId, item]));
  for (const appointment of resources.appointments) {
    const service = services.get(appointment.serviceTypeId);
    if (!service || !clinicians.has(appointment.clinicianId) || !rooms.has(appointment.roomId)) throw new Error(`Appointment ${appointment.appointmentId} has an incomplete core bundle`);
    const types = appointment.equipmentUnitIds.map((id) => equipment.get(id)?.equipmentType);
    if (canonicalJson(types) !== canonicalJson(service.requiredEquipmentTypes)) throw new Error(`Appointment ${appointment.appointmentId} has an incomplete Equipment bundle`);
  }
  return { appointments: resources.appointments.length };
}

export function assertEventLedger(events) {
  const identities = new Map();
  const groups = new Map();
  for (const event of events) {
    const body = canonicalJson(event);
    if (identities.has(event.eventId) && identities.get(event.eventId) !== body) throw new Error(`Event ${event.eventId} changed semantic body`);
    identities.set(event.eventId, body);
    const sequences = groups.get(event.aggregateId) ?? [];
    sequences.push(event.sequence);
    groups.set(event.aggregateId, sequences);
  }
  for (const [aggregateId, sequences] of groups) {
    const actual = [...new Set(sequences)].sort((left, right) => left - right);
    const expected = Array.from({ length: actual.at(-1) ?? 0 }, (_, index) => index + 1);
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`Event sequence for ${aggregateId} is not contiguous`);
  }
  return { uniqueEvents: identities.size, aggregates: groups.size };
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0 || fraction < 0 || fraction > 1) throw new TypeError("invalid percentile input");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}
