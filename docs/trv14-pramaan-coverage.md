# TRV14 2.0.0: Pramaan coverage review

Every error site in Pramaan's TRV14 module (`ONDC-Official/log-validation-utility`, `utils/TRV/TRV-14/*`; 311 sites in 21 files) is classified against the in-house TRV14 validators in this service.

| Class | Meaning | Sites |
|---|---|---|
| L2 | Covered by a TRV14 rule in `src/validations/shared/trv14/` (with L1 / shared checks where noted) | 250 |
| N/A | Not applicable to the TRV14 workbench flows (ride-hailing leftovers, Pramaan-specific strict key/type checks, timestamp rules the workbench contradicts) | 61 |
| REVIEW | Needs a decision | 0 |

## Gaps found by this review and added (Phase 9)
1. A new request must not reuse an earlier request's `message_id` (`continuity.ts`).
2. on_select must echo the selected fulfillment; fulfillments (id, type, stop types) stay unchanged in on_status / on_cancel / on_update (`selectValidations.ts`, `statusValidations.ts`, `cancelUpdateValidations.ts`).
3. Every quote amount is in the quote's currency (`helpers.ts` `checkTrv14QuoteCurrency`).
4. Later on_search pages repeat page 1's categories and locations (`searchValidations.ts`).

## Not compared on purpose
- **Descriptor text** (names, short/long descriptions, images) across calls: cosmetic; presence is L1's job.
- **`created_at` / `updated_at` equal to `context.timestamp`:** the workbench stamps the context first.
- **Parity run:** Pramaan's TRV14 module targets an older version of the flows. Its purchase journey requires search and `select_1`/`select_2`, and uses values the workbench no longer sends, so a side-by-side run on the workbench fixtures would only show those structural differences. This line-by-line review replaces it.

## Every error site

| File | Line | Pramaan message | Class | Covered by / reason |
|---|---|---|---|---|
| onSearch.ts | 35 | Range start time can't be greater than end time. | L2 | searchValidations.ts (time.range start before end) |
| onSearch1.ts | 36 | onSearch and Onsearch1 cant have the same message id | L2 | continuity.ts (request message_id unique, on_* pairing) + shared timestamp order |
| onSearch1.ts | 46 | timestamp of on_Search can't be greater or equal to on_Search_1 | L2 | continuity.ts (request message_id unique, on_* pairing) + shared timestamp order |
| select_1.ts | 34 | parent_item_id can't have empty values for item with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect1.ts | 33 | prvdrid mismatches in select and on_select | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts (provider carried over) + searchValidations.ts (provider per page) |
| onSelect1.ts | 49 | itm price should not be there | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onSelect1.ts | 52 | itm quantity should not be there | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onSelect1.ts | 61 | parent item tags is missing | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect1.ts | 66 | parent tags descriptior code is not valid | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| onSelect1.ts | 71 | itm value can be empty string | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onSelect1.ts | 78 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onSelect1.ts | 99 | parent_item_id can't have empty values for item with id: ${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect1.ts | 102 | parent_item_id is missing in item obj with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect1.ts | 106 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onSelect1.ts | 114 | No items were selected for Add-ons | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect1.ts | 118 | ${itm.id} can't have empty string parent_item_id | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect1.ts | 121 | parent_item_id is missing in item obj with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect1.ts | 124 | ${itm.id} should have price object | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onSelect1.ts | 127 | ${itm.id} should have quantity object | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onSelect1.ts | 132 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onSelect1.ts | 139 | parent item object having descriptor.code as ABSTRACT was not found in items array | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect1.ts | 141 | child_item does not exist for the parent item | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect1.ts | 152 | ${itm.id} selected quantity mismatches on select and on_select | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onSelect1.ts | 155 | ${itm.id} does not exist in select | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onSelect1.ts | 167 | fulfillment id mismatched on select and on_select | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| onSelect1.ts | 170 | phone cant be empty string | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onSelect1.ts | 173 | email cant be empty string | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onSelect1.ts | 202 | ${itm.item.id} does not have addons property in items | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect1.ts | 208 | ${itm.item.id} does not exist in select | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onSelect1.ts | 210 | ${itm.item.id} selected quantity mismatches | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onSelect1.ts | 228 | ${itm.id} has been already in items | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| select_2.ts | 37 | select_1 and select_2 message id can't be same | L2 | continuity.ts (request message_id unique, on_* pairing) + shared timestamp order |
| select_2.ts | 46 | prvdrId mismatch in select2 | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts (provider carried over) + searchValidations.ts (provider per page) |
| select_2.ts | 86 | the xinput form dont't match | L2 | selectValidations.ts (form placement and round-trip) + L1 xinput presence |
| onSelect2.ts | 43 | prvdrid mismatches in select and on_select | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts (provider carried over) + searchValidations.ts (provider per page) |
| onSelect2.ts | 51 | ${itm.id} selected quantity mismatches on select and on_select | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onSelect2.ts | 54 | ${itm.id} doesnot exist in select | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onSelect2.ts | 63 | fulfillment id mismatched on select and on_select | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| onSelect2.ts | 95 | quote breakup summation is not correct | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| onSelect2.ts | 116 | itm price should not be there | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onSelect2.ts | 119 | itm quantity should not be there | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onSelect2.ts | 123 | parent_item_id can't be empty string | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect2.ts | 127 | parent item tags is missing | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect2.ts | 132 | parent tags descriptior code is not valid | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| onSelect2.ts | 137 | itm value can be empty string | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onSelect2.ts | 144 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onSelect2.ts | 164 | parent_item_id can't have empty values for item with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect2.ts | 167 | parent_item_id is missing in item obj with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect2.ts | 171 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onSelect2.ts | 180 | No items were selected for Add-ons | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect2.ts | 184 | ${itm.id} can't have empty string parent_item_id | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect2.ts | 187 | parent_item_id is missing in item obj with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect2.ts | 190 | ${itm.id} should have price object | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onSelect2.ts | 193 | ${itm.id} should have quantity object | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onSelect2.ts | 198 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onSelect2.ts | 205 | parent item object having descriptor.code as ABSTRACT was not found in items array | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onSelect2.ts | 207 | child_item does not found having descriptor.code as ENTRY_PASS | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| init.ts | 36 | provider id mismatches in init and on_select | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts (provider carried over) + searchValidations.ts (provider per page) |
| init.ts | 42 | init and select2 message id cant be the same | L2 | continuity.ts (request message_id unique, on_* pairing) + shared timestamp order |
| init.ts | 52 | item with id:${itm.id} missing parent_item_id | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| init.ts | 56 | item with id:${itm.id} can't have empty parent_item_id | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| init.ts | 60 | ${itm.id} was not in select call | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| init.ts | 63 | ${itm.id} quantity is changed from previous call's selected quantity | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onInit.ts | 44 | prvdr id mismatches on on_init and init | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts (provider carried over) + searchValidations.ts (provider per page) |
| onInit.ts | 63 | fulfillment index:${index} agent is missing | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onInit.ts | 67 | fulfillment index:${index} agent organization is missing | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onInit.ts | 92 | fulfillment index:${index} vehicle is missing | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onInit.ts | 96 | fulfillment index:${index} vehicle.category is missing | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onInit.ts | 146 | quote breakup summation is not correct | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| onInit.ts | 179 | itm price should not be there | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onInit.ts | 182 | itm quantity should not be there | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onInit.ts | 186 | parent_item_id can't be empty string | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onInit.ts | 190 | parent item tags is missing | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onInit.ts | 195 | parent tags descriptior code is not valid | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| onInit.ts | 200 | itm value can be empty string | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onInit.ts | 207 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onInit.ts | 228 | parent_item_id can't have empty values for item with id: ${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onInit.ts | 231 | parent_item_id is missing in item obj with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onInit.ts | 235 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onInit.ts | 244 | No items were selected for Add-ons | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onInit.ts | 248 | ${itm.id} can't have empty string parent_item_id | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onInit.ts | 251 | parent_item_id is missing in item obj with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onInit.ts | 254 | ${itm.id} should have price object | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onInit.ts | 257 | ${itm.id} should have quantity object | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onInit.ts | 262 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onInit.ts | 269 | parent item object having descriptor.code as ABSTRACT was not found in items array | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onInit.ts | 271 | child_item does not found having descriptor.code as ENTRY_PASS | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onInit.ts | 288 | ${itm.item.id} does not have addons property in items | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onInit.ts | 294 | ${itm.item.id} does not exist in select | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onInit.ts | 296 | ${itm.item.id} selected quantity mismatches | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| confirm.ts | 34 | provider id mismatches in init and on_select | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts (provider carried over) + searchValidations.ts (provider per page) |
| confirm.ts | 40 | confirm and init message id cant be the same | L2 | continuity.ts (request message_id unique, on_* pairing) + shared timestamp order |
| confirm.ts | 50 | item with id:${itm.id} missing parent_item_id | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| confirm.ts | 54 | item with id:${itm.id} can't have empty parent_item_id | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| confirm.ts | 58 | ${itm.id} was not in select call | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| confirm.ts | 61 | ${itm.id} quantity is changed from previous call's selected quantity | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| confirm.ts | 78 | payment id mismatches with init call | L2 | initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (payments carried over, amount = quote total) + stateTable.ts (status) |
| confirm.ts | 80 | payment collected_by mismatches with init call | L2 | initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (payments carried over, amount = quote total) + stateTable.ts (status) |
| confirm.ts | 83 | payment type mismatches with init call | L2 | initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (payments carried over, amount = quote total) + stateTable.ts (status) |
| onConfirm.ts | 64 | fulfillment index:${index} agent is missing | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onConfirm.ts | 68 | fulfillment index:${index} agent organization is missing | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onConfirm.ts | 93 | fulfillment index:${index} vehicle is missing | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onConfirm.ts | 97 | fulfillment index:${index} vehicle.category is missing | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onConfirm.ts | 120 | itm price should not be there | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onConfirm.ts | 123 | itm quantity should not be there | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onConfirm.ts | 127 | parent_item_id can't be empty string | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 131 | parent item tags is missing | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 136 | parent tags descriptior code is not valid | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| onConfirm.ts | 141 | itm/list  value can be empty string | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onConfirm.ts | 148 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onConfirm.ts | 169 | parent_item_id can't have empty values for item with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 172 | parent_item_id is missing in item obj with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 176 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onConfirm.ts | 185 | No items were selected for Add-ons | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 189 | ${itm.id} can't have empty string parent_item_id | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 192 | parent_item_id is missing in item obj with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 195 | ${itm.id} should have price object | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onConfirm.ts | 198 | ${itm.id} should have quantity object | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onConfirm.ts | 203 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onConfirm.ts | 210 | parent item object having descriptor.code as ABSTRACT was not found in items array | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 212 | child_item does not found having descriptor.code as ENTRY_PASS | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 244 | created at is missing | L2 | mandatoryFields.ts (status order_id / ref_id), statusValidations.ts (order id kept) + L1 presence |
| onConfirm.ts | 247 | updated at is missing | L2 | mandatoryFields.ts (status order_id / ref_id), statusValidations.ts (order id kept) + L1 presence |
| onConfirm.ts | 250 | created should match with timestamp | N/A | Workbench stamps context.timestamp before building the order (Phase 6); only created_at <= updated_at is enforced |
| onConfirm.ts | 253 | updated should match with timestamp | N/A | Workbench stamps context.timestamp before building the order (Phase 6); only created_at <= updated_at is enforced |
| onConfirm.ts | 300 | quote breakup summation is not correct | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| onConfirm.ts | 313 | Cancellation_eligible is missing at index: ${index} | L2 | selectValidations.ts (form placement and round-trip) + L1 xinput presence |
| onConfirm.ts | 352 | fulfillment index:${index} agent is missing | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onConfirm.ts | 356 | fulfillment index:${index} agent organization is missing | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onConfirm.ts | 381 | fulfillment index:${index} vehicle is missing | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onConfirm.ts | 385 | fulfillment index:${index} vehicle category is missing | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| onConfirm.ts | 388 | fulfillment index:${index} cant be empty string | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| onConfirm.ts | 407 | itm price should not be there | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onConfirm.ts | 410 | itm quantity should not be there | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onConfirm.ts | 414 | parent_item_id can't be empty string | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 418 | parent item tags is missing | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 423 | parent tags descriptior code is not valid | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| onConfirm.ts | 428 | itm value can be empty string | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onConfirm.ts | 435 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onConfirm.ts | 456 | parent_item_id can't have empty values for item with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 459 | parent_item_id is missing in item obj with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 463 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onConfirm.ts | 472 | No items were selected for Add-ons | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 476 | ${itm.id} can't have empty string parent_item_id | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 479 | parent_item_id is missing in item obj with id:${itm.id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 482 | ${itm.id} should have price object | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onConfirm.ts | 485 | ${itm.id} should have quantity object | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| onConfirm.ts | 490 | '${key}' is not required in item obj with id:${itm.id} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| onConfirm.ts | 497 | parent item object having descriptor.code as ABSTRACT was not found in items array | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 499 | child_item does not found having descriptor.code as ENTRY_PASS | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| onConfirm.ts | 529 | final value of quote is not correct | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| onConfirm.ts | 537 | created at is missing | L2 | mandatoryFields.ts (status order_id / ref_id), statusValidations.ts (order id kept) + L1 presence |
| onConfirm.ts | 540 | updated at is missing | L2 | mandatoryFields.ts (status order_id / ref_id), statusValidations.ts (order id kept) + L1 presence |
| onConfirm.ts | 543 | created should match with timestamp | N/A | Workbench stamps context.timestamp before building the order (Phase 6); only created_at <= updated_at is enforced |
| onConfirm.ts | 546 | updated should match with timestamp | N/A | Workbench stamps context.timestamp before building the order (Phase 6); only created_at <= updated_at is enforced |
| status.ts | 24 | ref_id is missing on status | L2 | mandatoryFields.ts (status order_id / ref_id), statusValidations.ts (order id kept) + L1 presence |
| onStatus.ts | 37 | id mismatches in onConfirm and on_status | L2 | mandatoryFields.ts (status order_id / ref_id), statusValidations.ts (order id kept) + L1 presence |
| onStatus.ts | 104 | id is missing | L2 | mandatoryFields.ts (status order_id / ref_id), statusValidations.ts (order id kept) + L1 presence |
| onCancel1.ts | 38 | cancel timestamp can't be greater or equal to on_cancel timestamp | L2 | continuity.ts (request message_id unique, on_* pairing) + shared timestamp order |
| onCancel1.ts | 54 | error and message can't exist at the same time | L2 | cancelUpdateValidations.ts (a rejection carries an error and no order) |
| onCancel2.ts | 39 | cancellation object is missing | L2 | cancelUpdateValidations.ts (cancellation object, reason echo) + L1 presence |
| onCancel2.ts | 42 | cancellation.cancelby object is missing | L2 | cancelUpdateValidations.ts (cancellation object, reason echo) + L1 presence |
| onUpdate.ts | 104 | item ${itm.item.id} id mismatches | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| TRV14checks.ts | 9 | price.value is missing in quote | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 10 | price.currency is missing in quote | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 16 | Quote.breakup is missing | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 39 | Quote breakup is missing the following items: ${missingBreakupItems.join(', ')} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 49 | Quote breakup contains additional invalid items: ${additionalItemsList} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 61 | Invalid values in quote breakup | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 63 | Total of quote breakup (${totalBreakupValue}) does not match with price.value (${priceValue}) | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 69 | Currency must be the same for all items in the quote breakup | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 102 | descriptor does not exist | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 105 | descriptor code does not exist | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 110 | descriptor code is not valid | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 117 | descriptor code is not valid | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 130 | Replacement terms length mismatch: ${actual.length} vs ${expected.length} | L2 | Generic deep-compare helpers; the TRV14 L2 rules compare the fields that matter per step (items, quote, payments, fulfillments, terms) |
| TRV14checks.ts | 164 | Provider id mismatch: ${provider1.id} vs ${provider2.id} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts (provider carried over) + searchValidations.ts (provider per page) |
| TRV14checks.ts | 168 | Provider name mismatch: ${provider1.descriptor.name} vs ${provider2.descriptor.name} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts (provider carried over) + searchValidations.ts (provider per page) |
| TRV14checks.ts | 172 | Provider images length mismatch | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts (provider carried over) + searchValidations.ts (provider per page) |
| TRV14checks.ts | 177 | Provider image mismatch at index ${index} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts (provider carried over) + searchValidations.ts (provider per page) |
| TRV14checks.ts | 183 | Provider locations length mismatch | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts (provider carried over) + searchValidations.ts (provider per page) |
| TRV14checks.ts | 189 | Location id mismatch at index ${index} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 192 | Location gps mismatch at index ${index} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 195 | Location rating mismatch at index ${index} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 198 | Location name mismatch at index ${index} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 201 | Location short_desc mismatch at index ${index} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 206 | Location additional_desc mismatch at index ${index} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 210 | Location images length mismatch at index ${index} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 215 | Location image mismatch at location ${index}, image ${imgIndex} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 229 | Payments array length mismatch: ${payments1.length} vs ${payments2.length} | L2 | initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (payments carried over, amount = quote total) + stateTable.ts (status) |
| TRV14checks.ts | 237 | Payment id mismatch at index ${index}: ${p1.id} vs ${p2.id} | L2 | initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (payments carried over, amount = quote total) + stateTable.ts (status) |
| TRV14checks.ts | 241 | Payment collected_by mismatch at index ${index}: ${p1.collected_by} vs ${p2.collected_by} | L2 | initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (payments carried over, amount = quote total) + stateTable.ts (status) |
| TRV14checks.ts | 245 | Payment status mismatch at index ${index}: ${p1.status} vs ${p2.status} | L2 | initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (payments carried over, amount = quote total) + stateTable.ts (status) |
| TRV14checks.ts | 249 | Payment type mismatch at index ${index}: ${p1.type} vs ${p2.type} | L2 | initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (payments carried over, amount = quote total) + stateTable.ts (status) |
| TRV14checks.ts | 253 | Payment transaction_id mismatch at index ${index}: ${p1.params.transaction_id} vs ${p2.params.transaction_id} | L2 | initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (payments carried over, amount = quote total) + stateTable.ts (status) |
| TRV14checks.ts | 257 | Payment currency mismatch at index ${index}: ${p1.params.currency} vs ${p2.params.currency} | L2 | initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (payments carried over, amount = quote total) + stateTable.ts (status) |
| TRV14checks.ts | 261 | Payment amount mismatch at index ${index}: ${p1.params.amount} vs ${p2.params.amount} | L2 | initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (payments carried over, amount = quote total) + stateTable.ts (status) |
| TRV14checks.ts | 272 | Fulfillments array length mismatch: ${f1.length} vs ${f2.length} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 280 | Fulfillment id mismatch at index ${index}: ${a.id} vs ${b.id} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 283 | Fulfillment type mismatch at index ${index}: ${a.type} vs ${b.type} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 286 | Fulfillment state.descriptor.code mismatch at index ${index}: ${a.state.descriptor.code} vs ${b.state.descriptor.code} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 290 | Fulfillment stops length mismatch at index ${index} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 296 | Stop type mismatch at fulfillment ${index}, stop ${stopIndex}: ${stopA.type} vs ${stopB.type} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 300 | Stop additional_desc.url mismatch at fulfillment ${index}, stop ${stopIndex} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 304 | Stop additional_desc.content_type mismatch at fulfillment ${index}, stop ${stopIndex} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 308 | Stop timestamp mismatch at fulfillment ${index}, stop ${stopIndex} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 315 | Agent contact phone mismatch at fulfillment ${index} | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| TRV14checks.ts | 319 | Agent contact email mismatch at fulfillment ${index} | N/A | Ride-hailing / billing-contact leftover; TRV14 sends no vehicle agent, and the workbench sends billing as {} |
| TRV14checks.ts | 323 | Vehicle category mismatch at fulfillment ${index} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 340 | Fulfillment count mismatch: ${sortedActual.length} vs ${sortedExpected.length} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 349 | ${context}: ID mismatch - ${aFulfillment.id} vs ${eFulfillment.id} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 356 | ${context}: Stops length mismatch - ${aStops.length} vs ${eStops.length} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 363 | ${stopCtx}: Type mismatch - ${aStop.type} vs ${eStop.type} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 369 | ${stopCtx}: Timestamp mismatch - ${aTimestamp} vs ${eTimestamp} | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 382 | Item array length mismatch: ${items1.length} vs ${items2.length} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| TRV14checks.ts | 396 | ${path} id mismatch: ${a.id} vs ${b.id} | L2 | Generic deep-compare helpers; the TRV14 L2 rules compare the fields that matter per step (items, quote, payments, fulfillments, terms) |
| TRV14checks.ts | 397 | ${path} name mismatch | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 398 | ${path} code mismatch | L2 | Generic deep-compare helpers; the TRV14 L2 rules compare the fields that matter per step (items, quote, payments, fulfillments, terms) |
| TRV14checks.ts | 399 | ${path} short_desc mismatch | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 400 | ${path} long_desc mismatch | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 405 | ${path} images length mismatch | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 409 | ${path} image mismatch at index ${idx} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 414 | ${path} parent_item_id mismatch | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| TRV14checks.ts | 417 | ${path} location_ids mismatch | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 421 | ${path} category_ids mismatch | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 426 | ${path} price mismatch | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 429 | ${path} price presence mismatch | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 433 | ${path} quantity mismatch | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| TRV14checks.ts | 438 | ${path} time mismatch | L2 | Generic deep-compare helpers; the TRV14 L2 rules compare the fields that matter per step (items, quote, payments, fulfillments, terms) |
| TRV14checks.ts | 441 | ${path} time presence mismatch | L2 | Generic deep-compare helpers; the TRV14 L2 rules compare the fields that matter per step (items, quote, payments, fulfillments, terms) |
| TRV14checks.ts | 445 | ${path} fulfillment_ids mismatch | L2 | selectValidations.ts (fulfillment echo), statusValidations.ts / cancelUpdateValidations.ts (fulfillments unchanged), stateTable.ts (state) |
| TRV14checks.ts | 452 | ${path} add_ons length mismatch | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| TRV14checks.ts | 456 | ${path} add_on id mismatch at index ${idx} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| TRV14checks.ts | 457 | ${path} add_on name mismatch at index ${idx} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| TRV14checks.ts | 458 | ${path} add_on quantity mismatch at index ${idx} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| TRV14checks.ts | 460 | ${path} add_on price mismatch at index ${idx} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| TRV14checks.ts | 469 | ${path} tags length mismatch | L2 | initConfirmValidations.ts (BAP_TERMS / BPP_TERMS carried over) + L1 tag code lists |
| TRV14checks.ts | 474 | ${path} tag descriptor.code mismatch at index ${tIdx} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 477 | ${path} tag list length mismatch at index ${tIdx} | L2 | initConfirmValidations.ts (BAP_TERMS / BPP_TERMS carried over) + L1 tag code lists |
| TRV14checks.ts | 482 | ${path} tag list value mismatch at tag ${tIdx}, item ${li} | L2 | initConfirmValidations.ts (BAP_TERMS / BPP_TERMS carried over) + L1 tag code lists |
| TRV14checks.ts | 485 | ${path} tag list descriptor.code mismatch at tag ${tIdx}, item ${li} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 512 | Items length mismatch: ${actualMap.size} vs ${expectedMap.size} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| TRV14checks.ts | 520 | ${context}: Missing in actual | L2 | Generic deep-compare helpers; the TRV14 L2 rules compare the fields that matter per step (items, quote, payments, fulfillments, terms) |
| TRV14checks.ts | 525 | ${context}: Parent item ID mismatch - ${aItem.parent_item_id} vs ${eItem.parent_item_id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| TRV14checks.ts | 531 | ${context}: Quantity count mismatch - ${aQty} vs ${eQty} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| TRV14checks.ts | 538 | ${context}: Add-on count mismatch - ${aAddOnsMap.size} vs ${eAddOnsMap.size} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| TRV14checks.ts | 546 | ${addonCtx}: Missing in actual | L2 | Generic deep-compare helpers; the TRV14 L2 rules compare the fields that matter per step (items, quote, payments, fulfillments, terms) |
| TRV14checks.ts | 553 | ${addonCtx}: Quantity count mismatch - ${aAddQty} vs ${eAddQty} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| TRV14checks.ts | 571 | Unexpected key in actual quote: '${k}' | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| TRV14checks.ts | 574 | Missing key in actual quote: '${k}' | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 582 | Quote price mismatch: ${JSON.stringify(actual.price)} vs ${JSON.stringify(expected.price)} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 603 | Breakup length mismatch: ${aBreakup.length} vs ${eBreakup.length} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 612 | Title mismatch ${context}: ${aItem.title} vs ${eItem.title} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 616 | Item ID mismatch ${context}: ${aItem.item?.id} vs ${eItem.item?.id} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| TRV14checks.ts | 620 | Price mismatch ${context}: ${JSON.stringify(aItem.price)} vs ${JSON.stringify(eItem.price)} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 624 | Item price mismatch ${context}: ${JSON.stringify(aItem.item?.price)} vs ${JSON.stringify(eItem.item?.price)} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (quote lines and continuity), helpers.ts (currency), shared breakup total |
| TRV14checks.ts | 628 | Item quantity mismatch ${context}: ${aItem.item?.quantity?.selected?.count} vs ${eItem.item?.quantity?.selected?.count} | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| TRV14checks.ts | 635 | Add-on count mismatch ${context}: ${aAddOns.length} vs ${eAddOns.length} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| TRV14checks.ts | 639 | Add-on ID mismatch ${context}, add-on index ${idx}: ${addon.id} vs ${eAddOns[idx].id} | L2 | selectValidations.ts / searchValidations.ts (parent ABSTRACT, add-on echo and quantities) + L1 presence |
| TRV14checks.ts | 668 | Missing in actual | L2 | Generic deep-compare helpers; the TRV14 L2 rules compare the fields that matter per step (items, quote, payments, fulfillments, terms) |
| TRV14checks.ts | 687 | Missing list entry for key "${key}" | L2 | initConfirmValidations.ts (BAP_TERMS / BPP_TERMS carried over) + L1 tag code lists |
| TRV14checks.ts | 692 | Value mismatch for "${key}" - ${actualValue} vs ${expectedValue} | L2 | Generic deep-compare helpers; the TRV14 L2 rules compare the fields that matter per step (items, quote, payments, fulfillments, terms) |
| TRV14checks.ts | 698 | Unexpected key in list - "${key}" | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| TRV14checks.ts | 716 | xinput is missing | L2 | selectValidations.ts (form placement and round-trip) + L1 xinput presence |
| TRV14checks.ts | 723 | Missing 'head' in xinput | L2 | selectValidations.ts (form placement and round-trip) + L1 xinput presence |
| TRV14checks.ts | 727 | 'head.descriptor.name' must be a non-empty string | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 733 | 'head.index.${k}' must be a string | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| TRV14checks.ts | 738 | 'head.headings' must be an array of strings | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| TRV14checks.ts | 745 | Missing or invalid 'form' | L2 | selectValidations.ts (form placement and round-trip) + L1 xinput presence |
| TRV14checks.ts | 748 | 'form.id' must be a non-empty string | L2 | selectValidations.ts (form placement and round-trip) + L1 xinput presence |
| TRV14checks.ts | 752 | 'form.mime_type' must be 'text/html' | L2 | selectValidations.ts (form placement and round-trip) + L1 xinput presence |
| TRV14checks.ts | 758 | 'form.url' must be a valid URL | L2 | selectValidations.ts (form placement and round-trip) + L1 xinput presence |
| TRV14checks.ts | 762 | 'form.resubmit' must be a boolean | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| TRV14checks.ts | 766 | 'form.multiple_sumbissions' must be a boolean | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| TRV14checks.ts | 772 | 'required' must be a boolean | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| TRV14checks.ts | 898 | Descriptor name mismatch: ${desc1?.name} vs ${desc2?.name} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 902 | Descriptor short_desc mismatch: ${desc1?.short_desc} vs ${desc2?.short_desc} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 906 | Descriptor long_desc mismatch: ${desc1?.long_desc} vs ${desc2?.long_desc} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 919 | Image in desc1 not found in desc2: ${img} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 926 | Image in desc2 not found in desc1: ${img} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 951 | Missing tag for descriptor.code: ${code} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 956 | Tag name mismatch for code ${code}: ${tag1?.descriptor?.name} vs ${tag2?.descriptor?.name} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 960 | Tag display mismatch for code ${code}: ${tag1?.display} vs ${tag2?.display} | L2 | initConfirmValidations.ts (BAP_TERMS / BPP_TERMS carried over) + L1 tag code lists |
| TRV14checks.ts | 978 | Missing list item for descriptor.code ${itemCode} in tag ${code} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 986 | Value mismatch in tag ${code} for descriptor.code ${itemCode}: ${val1} vs ${val2} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1004 | Location ${id} missing in second set | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1010 | Location ${id} gps mismatch: ${l1.gps} vs ${l2.gps} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1015 | Location ${id} rating mismatch: ${l1.rating} vs ${l2.rating} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1023 | Location ${id} descriptor.name mismatch: ${d1.name} vs ${d2.name} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1028 | Location ${id} descriptor.short_desc mismatch | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1033 | Location ${id} additional_desc.url mismatch | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1038 | Location ${id} additional_desc.content_type mismatch | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1050 | Location ${id} missing image in second: ${img} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1056 | Location ${id} extra image in second: ${img} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1064 | Extra location ${id} present in second set | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1081 | Category ${id} missing in second set | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1090 | Category ${id} name mismatch: ${d1.name} vs ${d2.name} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1095 | Category ${id} code mismatch: ${d1.code} vs ${d2.code} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1100 | Category ${id} parent_category_id mismatch: ${c1.parent_category_id} vs ${c2.parent_category_id} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1107 | Extra category ${id} found in second set | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1122 | ${itm.value} does not matches with call | L2 | selectValidations.ts / initConfirmValidations.ts / statusValidations.ts / cancelUpdateValidations.ts (items and quantities carried over) |
| TRV14checks.ts | 1151 | tags is missing for item id :${index} | L2 | initConfirmValidations.ts (BAP_TERMS / BPP_TERMS carried over) + L1 tag code lists |
| TRV14checks.ts | 1156 | tags must be an array | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| TRV14checks.ts | 1164 | Missing 'descriptor.code' | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1171 | '${code}' is not a valid descriptor.code | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1175 | 'list' must be an array | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| TRV14checks.ts | 1184 | 'descriptor.code' is required for FARE_POLICY items | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1186 | '${item.descriptor.code}' is not allowed for FARE_POLICY | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
| TRV14checks.ts | 1190 | 'value' is required for FARE_POLICY items | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| TRV14checks.ts | 1194 | 'value' is required for ${code} | N/A | Strict key/type checks of Pramaan's own shape; the workbench schema (L0) and L1 decide allowed keys and types |
| TRV14checks.ts | 1198 | 'descriptor' is not allowed in ${code} | L2 | searchValidations.ts (page 1 categories/locations repeated on later pages, category parents) + L1 presence; descriptor text across calls is not compared (cosmetic) |
