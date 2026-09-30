# ParcelFlow Context

ParcelFlow models durable inventory reservation and asynchronous warehouse fulfillment. This
language is for benchmark design and keeps the public task, dialogue, and evaluator consistent.

## Catalog and inventory

**Warehouse**:
A physical inventory location with a stable priority used by allocation policy.
_Avoid_: Store, depot, node

**SKU**:
A sellable catalog item referenced by exactly one order line.
_Avoid_: Product, item, merchandise

**Stock Position**:
The current `onHand` and `reserved` quantities for one Warehouse and one SKU.
_Avoid_: Stock row, inventory bucket

## Ordering and fulfillment

**Order**:
A customer's all-or-nothing request containing one to eight distinct SKU lines.
_Avoid_: Purchase, cart, reservation

**Order Line**:
The requested quantity of one SKU within an Order.
_Avoid_: Item, detail row

**Allocation**:
A quantity reserved from one Stock Position for one Order Line until it is shipped or cancelled.
_Avoid_: Hold, assignment

**Fulfillment**:
The Allocations for one Order that will be dispatched from one Warehouse as a group.
_Avoid_: Package, batch, delivery

**Dispatch Task**:
The durable, lease-owned background work that converts one Fulfillment into a Shipment.
_Avoid_: Job, queue item

**Shipment**:
The immutable result of successfully dispatching one Fulfillment.
_Avoid_: Dispatch, fulfillment result

## Events and retries

**Domain Event**:
A versioned fact committed with business state and identified by `eventId`, `orderId`, and Order
sequence.
_Avoid_: Message, notification, webhook

**Outbox Delivery**:
The retryable delivery state for sending one Domain Event to the configured webhook.
_Avoid_: Event, notification

**Idempotency Record**:
The durable replay result for one scoped HTTP mutation and semantic request.
_Avoid_: Event, request cache
