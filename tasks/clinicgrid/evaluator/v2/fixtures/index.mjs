import { createHash } from "node:crypto";

function hash(seed, ...parts) {
  const digest = createHash("sha256").update(String(seed));
  for (const part of parts) digest.update("\0").update(String(part));
  return digest.digest();
}

function offsetMs(offset = {}) {
  return (offset.days ?? 0) * 86_400_000 + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000 + (offset.seconds ?? 0) * 1_000 + (offset.milliseconds ?? 0);
}

function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 32) || "value"; }

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) throw new TypeError("evaluationSeed, caseId and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    evaluationSeed: String(evaluationSeed), caseId: String(caseId), baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = hash(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = bytes.toString("hex");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    },
    at(offset = {}) { return new Date(epoch + offsetMs(offset)).toISOString(); },
    key(label) { return `cg-${slug(caseId)}-${slug(label)}-${hash(namespace, "key", label).toString("hex").slice(0, 18)}`.slice(0, 128); },
    integer(label, minimum, maximum) {
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum) throw new TypeError("invalid integer range");
      return minimum + (hash(namespace, "integer", label).readUInt32BE(0) % (maximum - minimum + 1));
    },
  });
}

export function baseSeed(fixtures, options = {}) {
  const available = [{ startAt: fixtures.at({ days: -1, hours: -4 }), endAt: fixtures.at({ days: 31, hours: 4 }) }];
  const clinicians = Array.from({ length: options.clinicians ?? 2 }, (_, index) => ({
    clinicianId: fixtures.uuid(`clinician-${index}`), name: `Clinician ${index}`, priority: index + 1, availability: structuredClone(available),
  }));
  const rooms = [
    { roomId: fixtures.uuid("room-priority-2"), name: "Room Two", priority: 2, availability: structuredClone(available) },
    { roomId: fixtures.uuid("room-priority-1"), name: "Room One", priority: 1, availability: structuredClone(available) },
    { roomId: fixtures.uuid("room-priority-3"), name: "Room Three", priority: 3, availability: structuredClone(available) },
  ];
  const equipmentUnits = [
    { equipmentUnitId: fixtures.uuid("ecg-priority-2"), equipmentType: "ECG", priority: 2, availability: structuredClone(available) },
    { equipmentUnitId: fixtures.uuid("ecg-priority-1"), equipmentType: "ECG", priority: 1, availability: structuredClone(available) },
    { equipmentUnitId: fixtures.uuid("mri-priority-2"), equipmentType: "MRI", priority: 2, availability: structuredClone(available) },
    { equipmentUnitId: fixtures.uuid("mri-priority-1"), equipmentType: "MRI", priority: 1, availability: structuredClone(available) },
  ];
  const serviceTypes = [
    { serviceTypeId: fixtures.uuid("service-complete"), name: "Complete Consultation", durationMinutes: 30, requiredEquipmentTypes: ["ECG", "MRI"] },
    { serviceTypeId: fixtures.uuid("service-simple"), name: "Simple Consultation", durationMinutes: 15, requiredEquipmentTypes: ["ECG"] },
  ];
  const patients = Array.from({ length: options.patients ?? 24 }, (_, index) => ({ patientId: fixtures.uuid(`patient-${index}`), name: `Patient ${index}` }));
  return {
    schemaVersion: 1,
    seedVersion: options.seedVersion ?? `cg-${slug(fixtures.caseId)}-${hash(fixtures.evaluationSeed, fixtures.caseId, "seed").toString("hex").slice(0, 12)}`,
    clinicians,
    rooms,
    equipmentUnits,
    serviceTypes,
    patients,
    appointments: options.appointments ?? [],
    waitlistEntries: options.waitlistEntries ?? [],
  };
}

export function appointmentRequest(seed, fixtures, options = {}) {
  return {
    patientId: options.patientId ?? seed.patients[0].patientId,
    serviceTypeId: options.serviceTypeId ?? seed.serviceTypes[0].serviceTypeId,
    clinicianId: options.clinicianId ?? seed.clinicians[0].clinicianId,
    startAt: options.startAt ?? fixtures.at({ hours: 1 }),
  };
}

export function carePlanRequest(seed, fixtures, count = 3, options = {}) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 13) throw new TypeError("fixture visit count must be 1..13");
  return {
    patientId: options.patientId ?? seed.patients[0].patientId,
    visits: Array.from({ length: count }, (_, index) => ({
      serviceTypeId: seed.serviceTypes[index % seed.serviceTypes.length].serviceTypeId,
      clinicianId: seed.clinicians[index % seed.clinicians.length].clinicianId,
      startAt: fixtures.at({ hours: 1 + index }),
    })),
  };
}

export function planWorkedExample(fixtures) {
  const visits = [
    { visitIndex: 1, appointment: { appointmentId: fixtures.uuid("worked-appointment-1"), state: "CONFIRMED", expiresAt: fixtures.at({ seconds: 120 }) } },
    { visitIndex: 2, appointment: { appointmentId: fixtures.uuid("worked-appointment-2"), state: "HELD", expiresAt: fixtures.at({ seconds: 121 }) } },
    { visitIndex: 3, appointment: { appointmentId: fixtures.uuid("worked-appointment-3"), state: "HELD", expiresAt: fixtures.at({ seconds: 122 }) } },
  ];
  return { visits, cancelledVisitIndex: 2 };
}

export function performanceContract() {
  return Object.freeze({
    availability: { clients: 64, warmupSeconds: 10, measureSeconds: 60, throughput: 200, p95Ms: 180 },
    holds: { clients: 64, warmupSlots: 30, measuredSlots: 180, contenders: 10, warmupSeconds: 10, measureSeconds: 60, throughput: 30, p95Ms: 600 },
    recovery: { dueAppointments: 1_000, waitingEntries: 1_000, killedWorkers: 2, replacements: 2, seconds: 45 },
    seed: { clinicians: 2_000, rooms: 2_000, equipmentUnits: 4_000, serviceTypes: 20, patients: 100_000, appointments: 51_000, waitlistEntries: 1_000 },
  });
}

export function performanceSeed(fixtures) {
  const anchor = new Date(fixtures.baseTime);
  const midnight = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  const perfAt = (day, minutes = 0) => new Date(midnight + day * 86_400_000 + minutes * 60_000).toISOString();
  const availabilityFor = (ordinal) => [{ startAt: perfAt(ordinal % 31), endAt: perfAt((ordinal % 31) + 1) }];
  const serviceTypes = Array.from({ length: 20 }, (_, index) => ({
    serviceTypeId: fixtures.uuid(`perf-service-${index}`), name: `Service ${index}`, durationMinutes: 15, requiredEquipmentTypes: [`TYPE-${index}`],
  }));
  const clinicians = Array.from({ length: 2_000 }, (_, index) => ({ clinicianId: fixtures.uuid(`perf-clinician-${index}`), name: `Clinician ${index}`, priority: index + 1, availability: availabilityFor(index) }));
  const rooms = Array.from({ length: 2_000 }, (_, index) => ({ roomId: fixtures.uuid(`perf-room-${index}`), name: `Room ${index}`, priority: index + 1, availability: availabilityFor(index) }));
  const equipmentUnits = Array.from({ length: 4_000 }, (_, index) => ({
    equipmentUnitId: fixtures.uuid(`perf-equipment-${index}`), equipmentType: `TYPE-${Math.floor(index / 2) % 20}`,
    priority: Math.floor(index / 40) * 2 + (index % 2) + 1,
    availability: availabilityFor(Math.floor(index / 40) * 2 + (index % 2)),
  }));
  const equipmentByTypeDay = new Map();
  for (const unit of equipmentUnits) {
    const key = `${unit.equipmentType}\0${unit.availability[0].startAt}`;
    const values = equipmentByTypeDay.get(key) ?? [];
    values.push(unit);
    equipmentByTypeDay.set(key, values);
  }
  const patients = Array.from({ length: 100_000 }, (_, index) => ({ patientId: fixtures.uuid(`perf-patient-${index}`), name: `Patient ${index}` }));
  const appointments = [];
  for (let index = 0; index < 50_000; index += 1) {
    const owner = index % 2_000;
    const slot = Math.floor(index / 2_000);
    const serviceIndex = owner % 20;
    const ownerDay = owner % 31;
    const candidates = equipmentByTypeDay.get(`TYPE-${serviceIndex}\0${perfAt(ownerDay)}`);
    const sameTypeDayRank = Math.floor(owner / 20 / 31);
    const unit = candidates[sameTypeDayRank];
    const startAt = perfAt(ownerDay, slot * 15);
    appointments.push({
      appointmentId: fixtures.uuid(`perf-confirmed-${index}`), patientId: patients[index].patientId,
      serviceTypeId: serviceTypes[serviceIndex].serviceTypeId, clinicianId: clinicians[owner].clinicianId,
      roomId: rooms[owner].roomId, equipmentUnitIds: [unit.equipmentUnitId],
      startAt, endAt: perfAt(ownerDay, slot * 15 + 15), state: "CONFIRMED",
      expiresAt: perfAt(-1), confirmedAt: perfAt(-1), terminalAt: null, sequence: 2,
    });
  }
  for (let index = 0; index < 1_000; index += 1) {
    const serviceIndex = index % 20;
    const ownerDay = index % 31;
    const candidates = equipmentByTypeDay.get(`TYPE-${serviceIndex}\0${perfAt(ownerDay)}`);
    const sameTypeDayRank = Math.floor(index / 20 / 31);
    const unit = candidates[sameTypeDayRank];
    appointments.push({
      appointmentId: fixtures.uuid(`perf-held-${index}`), patientId: patients[50_000 + index].patientId,
      serviceTypeId: serviceTypes[serviceIndex].serviceTypeId, clinicianId: clinicians[index].clinicianId,
      roomId: rooms[index].roomId, equipmentUnitIds: [unit.equipmentUnitId],
      startAt: perfAt(ownerDay, 600), endAt: perfAt(ownerDay, 615), state: "HELD",
      expiresAt: perfAt(-1), confirmedAt: null, terminalAt: null, sequence: 1,
    });
  }
  const waitlistEntries = Array.from({ length: 1_000 }, (_, index) => ({
    waitlistEntryId: fixtures.uuid(`perf-waitlist-${index}`), patientId: patients[51_000 + index].patientId,
    serviceTypeId: serviceTypes[index % 20].serviceTypeId, earliestStart: perfAt(0), latestEnd: perfAt(31),
    priority: 100 - (index % 101), state: "WAITING", joinedAt: new Date(midnight - 86_400_000 + index).toISOString(), appointmentId: null,
  }));
  return { schemaVersion: 1, seedVersion: "perf-v1", clinicians, rooms, equipmentUnits, serviceTypes, patients, appointments, waitlistEntries };
}
