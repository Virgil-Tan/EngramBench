import { T, FUTURE, id, ref, record as r, obj, pick, list, union, nullable, name, text, uuid, time, nat, pos, int, interval, empty, page, operation as op, finish, pagination, query, domainEventsOperation, snapshotSmoke, idem, manager, wire, detailedTransportErrors } from './helpers-b.mjs';
const I = n => id(2,n);
const s = {
  Clinician:r('clinicianId:uuid name:string priority:int',{availability:list(interval)}),
  Room:r('roomId:uuid name:string priority:int',{availability:list(interval)}),
  EquipmentUnit:r('equipmentUnitId:uuid equipmentType:string priority:int',{availability:list(interval)}),
  Patient:r('patientId:uuid name:string'),
  ServiceType:r('serviceTypeId:uuid name:string',{durationMinutes:{...int,minimum:15,maximum:240,multipleOf:15},requiredEquipmentTypes:list(text)}),
  Appointment:r('appointmentId:uuid patientId:uuid serviceTypeId:uuid clinicianId:uuid roomId:uuid equipmentUnitIds:[uuid] startAt:timestamp endAt:timestamp state:HELD|CONFIRMED|CANCELLED|EXPIRED expiresAt:timestamp confirmedAt:timestamp|null terminalAt:timestamp|null sequence:pos'),
  AvailabilitySlot:r('serviceTypeId:uuid clinicianId:uuid startAt:timestamp endAt:timestamp roomIds:[uuid]',{equipmentOptions:list(list(uuid))}),
  WaitlistEntry:r('waitlistEntryId:uuid patientId:uuid serviceTypeId:uuid earliestStart:timestamp latestEnd:timestamp state:WAITING|PROMOTED|WITHDRAWN joinedAt:timestamp appointmentId:uuid|null',{priority:{...nat,maximum:100}}),
  CalendarEntry:r('appointmentId:uuid startAt:timestamp endAt:timestamp'),
  CarePlan:r('carePlanId:uuid patientId:uuid state:HELD|PARTIALLY_CONFIRMED|CONFIRMED|TERMINATED expiresAt:timestamp|null createdAt:timestamp terminalAt:timestamp|null sequence:pos',{visits:list(r('visitIndex:pos appointment:Appointment'),{minItems:2,maxItems:12})}),
  CarePlanWaitlistEntry:r('waitlistEntryId:uuid patientId:uuid state:WAITING|PROMOTED|WITHDRAWN joinedAt:timestamp carePlanId:uuid|null',{priority:{...nat,maximum:100},visits:list(r('visitIndex:pos serviceTypeId:uuid clinicianId:uuid earliestStart:timestamp latestEnd:timestamp'),{minItems:2,maxItems:12})}),
};
const hold = pick(s.Appointment,['patientId','serviceTypeId','clinicianId','startAt']);
const wait = pick(s.WaitlistEntry,['patientId','serviceTypeId','earliestStart','latestEnd','priority']);
const careVisits = list(r('serviceTypeId:uuid clinicianId:uuid startAt:timestamp'),{minItems:2,maxItems:12});
const timeQuery = [query('from',time,true),query('to',time,true)];
const base={clinicians:'Clinician',rooms:'Room',equipmentUnits:'EquipmentUnit',patients:'Patient',serviceTypes:'ServiceType',appointments:'Appointment',waitlistEntries:'WaitlistEntry'};
const holdBody={patientId:I(3),serviceTypeId:I(4),clinicianId:I(1),startAt:FUTURE};
export default finish({taskId:'clinicgrid',title:'ClinicGrid',schemas:s,seedTypes:base,resources:{...base,carePlans:'CarePlan',carePlanWaitlistEntries:'CarePlanWaitlistEntry'},emptyEventPayload:true,environmentVariables:['CHROMIUM_PATH','MANAGED_DATA_ROOT'],transportErrors:detailedTransportErrors,
  seedData:{clinicians:[{clinicianId:I(1),name:'Public clinician',priority:1,availability:[{startAt:'2035-04-03T09:00:00.000Z',endAt:'2035-04-03T18:00:00.000Z'}]}],rooms:[{roomId:I(2),name:'Public room',priority:1,availability:[{startAt:'2035-04-03T09:00:00.000Z',endAt:'2035-04-03T18:00:00.000Z'}]}],equipmentUnits:[{equipmentUnitId:I(5),equipmentType:'public-scanner',priority:1,availability:[{startAt:'2035-04-03T09:00:00.000Z',endAt:'2035-04-03T18:00:00.000Z'}]}],patients:[{patientId:I(3),name:'Public patient'}],serviceTypes:[{serviceTypeId:I(4),name:'Public consultation',durationMinutes:30,requiredEquipmentTypes:['public-scanner']}]},
  workKinds:['APPOINTMENT_EXPIRY','WAITLIST_PROMOTION'],eventTypes:['appointment.held','appointment.confirmed','appointment.cancelled','appointment.expired','waitlist.promoted'],
  operations:[
    op('appointments-list','GET','/api/v1/appointments',null,page(ref('Appointment')),{parameters:pagination}),
    op('appointment-get','GET','/api/v1/appointments/:appointmentId',null,ref('Appointment')),
    op('appointment-create','POST','/api/v1/appointments',hold,ref('Appointment'),{status:201,example:{body:holdBody}}),
    op('appointment-confirm','POST','/api/v1/appointments/:appointmentId/confirm',empty,ref('Appointment')),
    op('appointment-cancel','POST','/api/v1/appointments/:appointmentId/cancel',r('reason:name'),ref('Appointment')),
    op('waitlist-create','POST','/api/v1/waitlist-entries',union(wait,obj({patientId:uuid,priority:{...nat,maximum:100},visits:list(r('serviceTypeId:uuid clinicianId:uuid earliestStart:timestamp latestEnd:timestamp'),{minItems:2,maxItems:12})})),union(ref('WaitlistEntry'),ref('CarePlanWaitlistEntry')),{status:201,source:`${manager}; ${wire}`}),
    op('availability','GET','/api/v1/availability',null,obj({items:list(ref('AvailabilitySlot'))}),{parameters:[query('serviceTypeId',uuid,true),query('clinicianId',uuid,true),...timeQuery]}),
    op('resource-calendar','GET','/api/v1/resources/:resourceType/:resourceId/calendar',null,obj({items:list(ref('CalendarEntry'))}),{parameters:timeQuery}),
    op('care-plan-create','POST','/api/v1/care-plans',obj({patientId:uuid,visits:careVisits}),ref('CarePlan'),{status:201,source:manager}),
    op('care-plan-get','GET','/api/v1/care-plans/:carePlanId',null,ref('CarePlan'),{source:manager}),
    op('care-plan-visit-confirm','POST','/api/v1/care-plans/:carePlanId/visits/:visitIndex/confirm',empty,ref('CarePlan'),{source:`${manager}; ${wire}`}),
    op('care-plan-visit-cancel','POST','/api/v1/care-plans/:carePlanId/visits/:visitIndex/cancel',r('reason:name'),ref('CarePlan'),{source:`${manager}; ${wire}`}),
    op('care-plan-terminate','POST','/api/v1/care-plans/:carePlanId/terminate',r('reason:name'),ref('CarePlan'),{source:`${manager}; ${wire}`}),domainEventsOperation(),
  ],
  smoke:[snapshotSmoke([['clinicians',{clinicianId:I(1)}],['rooms',{roomId:I(2)}],['patients',{patientId:I(3)}],['serviceTypes',{serviceTypeId:I(4)}],['equipmentUnits',{equipmentUnitId:I(5)}]]),{operationId:'appointment-create',body:holdBody,headers:idem('clinic-hold'),expectStatus:201,capture:{appointmentId:['appointmentId']},expectBody:{patientId:I(3),serviceTypeId:I(4)}},{operationId:'appointment-get',params:{appointmentId:'${appointmentId}'},expectStatus:200,expectBody:{appointmentId:'${appointmentId}',patientId:I(3)}}],
  notes:['V2 wire clarification: calendar success is {items:[{appointmentId,startAt,endAt}]}; resourceType is clinician, room or equipmentUnit. Care-plan visit mutations return the complete CarePlan. A care-plan waitlist uses the distinct visits input and result shape. Availability is {items:[AvailabilitySlot]}. These envelopes and resourceType spellings were not fully fixed by the original route prose.','Seed is a usable future clinician/room/equipment/patient/service graph. It does not seed elapsed holds or assert allocation outside the published priorities. Manager visitIndex is one-based, as published.'],
});
