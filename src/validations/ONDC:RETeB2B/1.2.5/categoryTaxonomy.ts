// eB2B item category taxonomy: which categories exist, which `attribute` tag codes each
// one may carry, which of those are mandatory, and which statutory declaration block the
// category requires.
//
// Source of truth: the "EB2B Category Taxonomy" sheet
// (docs.google.com/spreadsheets/d/1yWgeAGl7nhsI1rM3lmiOGeNKyYGD41gRYAKSe_0OtDk),
// tab `EB2B-Categories` (92 categories: 29 grocery, 25 home & kitchen, 37 health,
// `Gift Voucher`) and tab `EB2B-Categories-2` (25 beauty & personal care) — 117 in all.
// `M` in the sheet becomes `mandatory: true`, `O` becomes `mandatory: false`.
//
// The same grid also exists in log-validation-utility (`constants/category.ts`:
// `groceryJSON` / `homeJSON` / `healthJSON` / `BPCJSON`), and the two agree on every
// M/O cell. That file supplies the value regexes, which the sheet does not carry. Known
// divergences, all resolved in favour of the sheet:
//
//   - `groceryJSON` holds `'Falseil & Ghee'`, a corrupted `'Oil & Ghee'`. Not carried over.
//   - `BPCObj` holds `colour_Name`; the protocol code is `colour_name`.
//   - `homeJSON` holds `'Cleaning Supplies'`, which the sheet does not list, and omits the
//     sheet's `Bins and Bathroom`, `Paint and Wallpapers`,
//     `Hardware, Tools and Home Safety` and `Books`.
//   - `healthObj` holds `usage_instruction` (singular) where the sheet's column reads
//     "Usage Instructions". Both spellings are accepted below — the attribute is optional
//     either way, so the only effect is on the unknown-code check.
//
// Two deliberate softenings, so that a blank spreadsheet cell is not read as "forbidden":
//
//   - `brand` is accepted (optional) on every category. The sheet leaves the Brand cell
//     empty for `Fruits and Vegetables`, `Eggs, Meat & Fish` and `Gift Voucher`, but
//     log-validation-utility's `groceryObj` allows brand across all of grocery, and a
//     seller branding a packet of atta is not committing a protocol error.
//   - `Bathroom and Kitchen Fixtures` is accepted alongside the sheet's
//     `Bathroom and Kitchen fixtures` (lowercase f). The two ONDC sources disagree on the
//     casing only — automation-specifications' `config/validations/index.yaml` capitalises
//     it — and failing a seller over that would be noise.
//
// The attributes the sheet marks with `*` ("suggestive enums available here") have no
// enum here: the sheet does not carry the value lists and log-validation-utility leaves
// them empty too. Only the four value rules that source file actually defines are applied.

export type AttributeRule = {
  mandatory: boolean;
  /** Allowed values, or a pattern the value must match. Absent = any non-empty value. */
  value?: string[] | RegExp;
};

export type CategoryAttributes = Record<string, AttributeRule>;

/** Which `@ondc/org/statutory_reqs_*` block the category must declare. */
export type StatutoryRequirement = "prepackaged_food" | "packaged_commodities" | "none";

// Value rules, from log-validation-utility constants/category.ts. The colour pattern is
// anchored at both ends here (the source leaves the tail open); ONDC colours are exactly
// six hex digits.
const HEX_COLOUR = /^#[a-fA-F0-9]{6}$/;
const DECIMAL_3DP = /^[0-9]+(\.[0-9]{1,3})?$/;
const DECIMAL_2DP = /^[0-9]+(\.[0-9]{1,2})?$/;

const opt = (value?: string[] | RegExp): AttributeRule => ({ mandatory: false, value });
const req = (value?: string[] | RegExp): AttributeRule => ({ mandatory: true, value });

/**
 * Builds a prototype-free lookup table. Both the category map and the per-category rule
 * objects are indexed with payload-supplied strings, so inherited members must not
 * resolve: on a plain object a `category_id` of `toString` finds
 * `Function.prototype.toString` (making an unknown category look known) and an attribute
 * code of `toString` or `constructor` passes the foreign-attribute check unnoticed.
 * `statutoryRequirementFor` is already safe because it gates on the `EB2B_CATEGORIES` Set.
 */
function table<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

// --- grocery (tab 1, rows 1-29) -------------------------------------------------------
// Brand is the only attribute the sheet lists, and it is optional throughout.
const GROCERY: CategoryAttributes = table({ brand: opt() });

// --- home & kitchen (tab 1, rows 30-54) -----------------------------------------------
// Thirteen attributes. `colour` and `colour_name` are always marked together, and the two
// categories with mandatory dimensions (Furniture, Electricals) are also the two with a
// mandatory `assembly_required`, so one flag covers both.
function home(opts: {
  brand?: "M" | "O";
  colour: "M" | "O";
  material: "M" | "O";
  dimensions?: boolean;
}): CategoryAttributes {
  const colour = opts.colour === "M" ? req : opt;
  const dims = opts.dimensions ? req : opt;
  return table({
    brand: opts.brand === "O" ? opt() : req(),
    colour: colour(HEX_COLOUR),
    colour_name: colour(),
    material: opts.material === "M" ? req() : opt(),
    size: opt(),
    weight: dims(DECIMAL_3DP),
    length: dims(DECIMAL_2DP),
    breadth: dims(DECIMAL_2DP),
    height: dims(DECIMAL_2DP),
    model: opt(),
    assembly_required: dims(),
    care_instructions: opt(),
    special_features: opt(),
  });
}

// --- health & wellness (tab 1, rows 55-91) --------------------------------------------
const HEALTH: CategoryAttributes = table({
  brand: req(),
  prescription_required: req(),
  usage_instructions: opt(),
  usage_instruction: opt(),
});

// --- beauty & personal care (tab 2) ---------------------------------------------------
function bpc(colour: "M" | "O"): CategoryAttributes {
  const c = colour === "M" ? req : opt;
  return table({
    brand: req(),
    colour: c(HEX_COLOUR),
    colour_name: c(),
    gender: opt(),
    concern: opt(),
    ingredient: opt(),
    conscious: opt(),
    preference: opt(),
    formulation: opt(),
    skin_type: opt(),
  });
}

export const CATEGORY_ATTRIBUTES: Record<string, CategoryAttributes> = table({
  // Grocery
  "Fruits and Vegetables": GROCERY,
  "Masala & Seasoning": GROCERY,
  "Oil & Ghee": GROCERY,
  "Eggs, Meat & Fish": GROCERY,
  "Bakery, Cakes & Dairy": GROCERY,
  "Pet Care": GROCERY,
  "Detergents and Dishwash": GROCERY,
  "Dairy and Cheese": GROCERY,
  "Snacks, Dry Fruits, Nuts": GROCERY,
  "Pasta, Soup and Noodles": GROCERY,
  "Cereals and Breakfast": GROCERY,
  "Sauces, Spreads and Dips": GROCERY,
  "Chocolates and Biscuits": GROCERY,
  "Cooking and Baking Needs": GROCERY,
  "Tinned and Processed Food": GROCERY,
  "Atta, Flours and Sooji": GROCERY,
  "Rice and Rice Products": GROCERY,
  "Dals and Pulses": GROCERY,
  "Salt, Sugar and Jaggery": GROCERY,
  "Energy and Soft Drinks": GROCERY,
  Water: GROCERY,
  "Tea and Coffee": GROCERY,
  "Fruit Juices and Fruit Drinks": GROCERY,
  "Snacks and Namkeen": GROCERY,
  "Ready to Cook and Eat": GROCERY,
  "Pickles and Chutney": GROCERY,
  "Indian Sweets": GROCERY,
  "Frozen Vegetables": GROCERY,
  "Frozen Snacks": GROCERY,

  // Home & kitchen
  "Home Decor": home({ colour: "M", material: "M" }),
  Furniture: home({ colour: "M", material: "M", dimensions: true }),
  "Home Furnishing - Bedding and Linen": home({ colour: "M", material: "M" }),
  "Bins and Bathroom": home({ colour: "O", material: "M" }),
  "Car and Shoe Care": home({ colour: "O", material: "O" }),
  "Disposables and Garbage Bags": home({ colour: "M", material: "M" }),
  "Fresheners and Repellents": home({ colour: "O", material: "O" }),
  "Mops, Brushes and Scrubs": home({ colour: "O", material: "M" }),
  "Party and Festive Needs": home({ colour: "O", material: "O" }),
  Flowers: home({ colour: "M", material: "O" }),
  "Pooja Needs": home({ colour: "O", material: "O" }),
  "Paint and Wallpapers": home({ colour: "M", material: "M" }),
  "Hardware, Tools and Home Safety": home({ colour: "O", material: "M" }),
  Electricals: home({ colour: "M", material: "M", dimensions: true }),
  "Bathroom and Kitchen fixtures": home({ colour: "M", material: "M" }),
  "Bathroom and Kitchen Fixtures": home({ colour: "M", material: "M" }),
  "Garden & Outdoor": home({ colour: "O", material: "M" }),
  "Sports and Fitness Equipment": home({ colour: "M", material: "M" }),
  Cookware: home({ colour: "M", material: "M" }),
  Serveware: home({ colour: "M", material: "M" }),
  "Kitchen Storage and Containers": home({ colour: "M", material: "M" }),
  "Kitchen Tools": home({ colour: "M", material: "M" }),
  "Closet/Laundry/Shoe Organization": home({ colour: "M", material: "M" }),
  "Toys and Games": home({ colour: "M", material: "M" }),
  Stationery: home({ colour: "M", material: "O" }),
  Books: home({ brand: "O", colour: "O", material: "O" }),

  // Health & wellness
  "Pain Relief": HEALTH,
  "Nutrition and Fitness Supplements": HEALTH,
  "Speciality Care": HEALTH,
  "Covid Essentials": HEALTH,
  "Diabetes Control": HEALTH,
  "Healthcare & Fitness Devices": HEALTH,
  Ayurvedic: HEALTH,
  Homeopathy: HEALTH,
  "Unani and Siddha": HEALTH,
  "Elder Care": HEALTH,
  "Baby Care": HEALTH,
  "Orthopaedic Care": HEALTH,
  "Mobility Aids": HEALTH,
  "Medicated Hair Care": HEALTH,
  "Medicated Skin Care": HEALTH,
  "Speciality Face Cleansers": HEALTH,
  "Gastric Care": HEALTH,
  "ENT Care": HEALTH,
  "Eye Care": HEALTH,
  "Cold and Cough": HEALTH,
  "Sexual Wellness": HEALTH,
  "Feminine Care": HEALTH,
  "Maternity Care": HEALTH,
  "Nursing and Feeding": HEALTH,
  "Hand Wash": HEALTH,
  Sanitizers: HEALTH,
  "Baby Care - Wipes and Buds": HEALTH,
  "Baby Care - Rash Creams": HEALTH,
  "Baby Care - Diapers and Accessories": HEALTH,
  "Health and Safety": HEALTH,
  "Oral Care": HEALTH,
  Contraceptives: HEALTH,
  "Breathe Easy": HEALTH,
  "Health Foods and Drinks": HEALTH,
  "Wound Care and Dressings": HEALTH,
  Surgicals: HEALTH,
  "Mental Wellness": HEALTH,

  // Gift Voucher carries no attributes of its own (tab 1 leaves the whole row blank).
  "Gift Voucher": table({ brand: opt() }),

  // Beauty & personal care
  Fragrance: bpc("O"),
  "Bath Soaps and Gels": bpc("O"),
  "Hair Oils, Care, and Styling": bpc("O"),
  "Shampoos and Conditioners": bpc("O"),
  "Shaving and Grooming": bpc("O"),
  "Beard Care and Tools": bpc("O"),
  "Grooming Tools and Accessories": bpc("O"),
  "Makeup - Nail Care": bpc("M"),
  "Makeup - Eyes": bpc("M"),
  "Makeup - Face": bpc("O"),
  "Makeup - Lips": bpc("M"),
  "Makeup - Body": bpc("O"),
  "Makeup - Remover": bpc("O"),
  "Makeup - Sets and Kits": bpc("O"),
  "Makeup - Tools and Brushes": bpc("O"),
  "Makeup - Kits and Combos": bpc("O"),
  "Skin Care - Face Cleansers": bpc("O"),
  "Skin Care - Hand and Feet": bpc("O"),
  "Body Care - Cleansers": bpc("O"),
  "Body Care - Moisturizers": bpc("O"),
  "Body Care - Loofah and Other Tools": bpc("O"),
  "Body Care - Bath Salt and Additives": bpc("O"),
  "Hair Care - Shampoo, Oils, Conditioners": bpc("O"),
  "Skin Care - Lotions, Moisturisers, and Creams": bpc("O"),
  "Skin Care - Oils and Serums": bpc("O"),
});

/** Every valid eB2B item `category_id`. */
export const EB2B_CATEGORIES: Set<string> = new Set(Object.keys(CATEGORY_ATTRIBUTES));

// Statutory mapping. Column B of tab 1 for the 92 categories there; tab 2 has no such
// column, so the 25 BPC categories come from automation-specifications
// `config/validations/index.yaml` (`ITEMS_STATUTORY_REQS_PACKAGED_COMMODITIES`), which
// lists them and which matches the sheet on every category the two share.
// A category that requires prepackaged food also requires packaged commodities — the
// sheet gives both keys on those rows — so `PREPACKAGED_FOOD` is a subset of the other.
const PREPACKAGED_FOOD = new Set([
  "Bakery, Cakes & Dairy",
  "Dairy and Cheese",
  "Snacks, Dry Fruits, Nuts",
  "Cereals and Breakfast",
  "Sauces, Spreads and Dips",
  "Chocolates and Biscuits",
  "Tinned and Processed Food",
  "Energy and Soft Drinks",
  "Fruit Juices and Fruit Drinks",
  "Snacks and Namkeen",
  "Ready to Cook and Eat",
  "Pickles and Chutney",
  "Indian Sweets",
  "Frozen Snacks",
]);

// The four categories the sheet leaves blank in column B.
const NO_STATUTORY = new Set([
  "Fruits and Vegetables",
  "Water",
  "Frozen Vegetables",
  "Gift Voucher",
]);

/**
 * The statutory block the category must declare. `prepackaged_food` implies that
 * `packaged_commodities` is required too.
 */
export function statutoryRequirementFor(categoryId: string): StatutoryRequirement {
  if (!EB2B_CATEGORIES.has(categoryId) || NO_STATUTORY.has(categoryId)) return "none";
  return PREPACKAGED_FOOD.has(categoryId) ? "prepackaged_food" : "packaged_commodities";
}
