### Source

ONDC "API Contract for Logistics (v1.2.0)" Google Doc (the live doc links
out to a separate, later v1.2.5 contract — this implementation is scoped to
1.2.0 only, following the doc's own 1.2.0-vs-1.2.5 split).

### L3 Validation Rules implemented

#### /search

- `intent/fulfillment/type` should be `'Delivery'`.
- For category `"Immediate Delivery"`: `time.duration` should be `<= PT60M`
  and `time.timestamp` should be the same day as `context/timestamp`.
- For category `"Same Day Delivery"`: `time.timestamp` should be the same
  day as `context/timestamp`.
- For category `"Next Day Delivery"`: `time.timestamp` should be the day
  after `context/timestamp`.
- `intent/@ondc/org/payload_details` (weight, dimensions, category) should
  be present — domain-specific, not generic Beckn.

#### /on_search

- `bpp/descriptor/tags[code=bpp_terms]` should include a `static_terms` URL
  (the transaction-level static-terms publishing mechanism).
- Both a forward shipment (`type="Delivery"`) and a backward shipment
  (`type="RTO"`) should be present per provider.
- `categories[].time.label` should be `"TAT"`.
- `items[].descriptor.code` should be `"P2P"` or `"P2H2P"`.
- `items[].fulfillment_id` should map to a real fulfillment ID.

#### /init

- `order/payment/type` should be `"ON-FULFILLMENT"`.
- `order/payment/collected_by` should be `"BPP"`.
- Billing `created_at` should not be future-dated w.r.t `context/timestamp`
  and should equal `updated_at`.

#### /on_init

- `order/quote/price/value` and every `breakup[].price.value` should have
  at most 2 decimal places, and the breakup should sum to the quote price.
- `order/quote/breakup[]/@ondc/org/title_type` should be one of the v1.2.0
  enum values: `delivery`, `rto`, `reverseqc`, `tax`, `diff`, `tax_diff`,
  `discount`.
- `order/cancellation_terms[]` should be present, each with a
  `fulfillment_state/descriptor/code` and a `cancellation_fee`
  (percentage or amount).

#### /confirm

- `order/created_at` and `order/updated_at` must be the same, and not
  future-dated w.r.t `context/timestamp`.
- `fulfillments/start/instructions` (pickup confirmation code) is required
  when `ready_to_ship = 'yes'`.
- `order/id` should be present.

#### /on_confirm

- `order/created_at`/`updated_at` timestamp checks, same as `/confirm`.
- Pickup/delivery timestamps cannot be provided before the order is picked
  up.
- `fulfillments/start/time/range` is required when `ready_to_ship = 'yes'`.

#### /update

- `message/update_target` should be `"fulfillment"` (the key discriminator
  field for this action in the v1.2.0 contract).
- `order/updated_at` cannot be future-dated w.r.t `context/timestamp`.
- `fulfillments/start` and `fulfillments/start/instructions` are required
  when `ready_to_ship = 'yes'`.

#### /on_update

- A weight/dimension-differential charge (`breakup[].@ondc/org/title_type`
  of `diff`/`tax_diff`) must come with `diff_dim`/`diff_weight` and
  `diff_proof` tags.
- `@ondc/org/awb_no` and a shipping label (`start/instructions/images`) are
  required for P2H2P shipments.
- `fulfillments/start/time/range` should be provided if `ready_to_ship =
  'yes'` in `/update`.

#### /on_status

- Payment status should be `'PAID'` once the order is `'Completed'` for
  payment type `'ON-FULFILLMENT'`.
- Pickup/delivery timestamps cannot be provided pre-pickup, cannot be
  future-dated, and the pickup timestamp cannot change once a fulfillment
  has moved past pickup.
- `fulfillments/tracking` should be enabled while a fulfillment is between
  pickup and delivery (active window per the v1.2.0 contract).

#### /track

- `message/order_id` is required; only callable after the rider is
  assigned (not independently verifiable from a single payload — flagged
  as a gap below).

#### /on_track

- `tracking/location/time/timestamp` and `tracking/location/updated_at`
  should not be future-dated w.r.t `context/timestamp`.
- `tracking/status` should be `'active'`.

#### /cancel

- `message/order_id` and `message/cancellation_reason_id` should be
  present (format/presence only — see gap below on the reason-code enum).

#### /on_cancel

- `order/cancellation/cancelled_by` and `order/cancellation/reason/id`
  should be present.
- A `precancel_state` tag (the fulfillment state right before
  cancellation) should be present, per the 23rd Dec 2023 changelog entry
  linking cancellation with IGM.
- RTO sub-flow: when a fulfillment of `type="RTO"` in state
  `"RTO-Initiated"` is present, `order/state` should be `"Cancelled"` and
  `order/quote/breakup` should include an `rto` title_type line item.

#### issue / on_issue / issue_status / on_issue_status

Not part of the v1.2.0 Logistics API contract itself (the contract's only
IGM touchpoint is the `igm_request` tag inside `/on_cancel`) — these four
actions are wired onto the existing generic `shared/igm/igm1` validator
(same pattern as `ONDC:TRV11`), since the `ORDER_FLOW_BASELINE_WITH_IGM
(v-1.0.0)` flow in `automation-specifications` exercises them as standard
Beckn issue-and-grievance actions, not Logistics-specific ones.

### Deliberate scope cuts / known gaps

- **Cancellation/RTO reason-code enums** are not validated against their
  real values — the v1.2.0 contract doc only links out to an external
  Google Sheet (hyperlocal and inter-city tabs) for the authoritative list,
  which was not fetched for this pass. `/cancel` and the RTO sub-flow only
  check presence/format of `cancellation_reason_id`, not membership in the
  real enum.
- **RTO quote cross-check against `/on_search`**: the contract states an
  RTO fulfillment's quote "must match what was quoted in `/on_search`", but
  implementing an exact cross-payload comparison without a verified real
  1.2.0 session payload to check the actual field shape against risked
  encoding a wrong assumption — only the RTO breakup line item's presence
  is checked, not its value against `/on_search`.
- **Idempotency / NACK-driven state-machine rules** ("Rules for order
  confirmation" section: retriable-error codes 66001/66002/66004,
  63001/63002, 66003, LBNP-vs-LSP cancellation-reason-996/997 handling) are
  not implemented — these describe live, two-sided retry/rollback behavior
  that a post-hoc, single-payload-at-a-time validator can't meaningfully
  check from recorded payloads alone.
- **Serviceability-check requirements** (LSP must validate pickup/dropoff
  locations at `/search`, `/init`, `/confirm`) aren't independently
  checkable from the recorded payloads either.
- `/status` has no dedicated file: none of the 5 `automation-specifications`
  flows for this domain/version exercise a standalone `status` request (only
  `on_status`), so no `status.ts` was added — add one if a real flow needs
  it later.
