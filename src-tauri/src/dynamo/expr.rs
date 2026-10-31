//! Builds KeyCondition/Filter/Condition expressions and their attribute maps.
//!
//! User supplied placeholders (`#n`, `:v`) are passed through untouched. Placeholders generated
//! here use a prefix (`#dbk0`, `:dbk0` ...) that is lengthened with `_` until no user placeholder
//! starts with it, so the two sets can never collide.

use std::collections::{BTreeMap, HashMap};

use aws_sdk_dynamodb::types::AttributeValue;
use serde_json::Value;

use super::model::{
    AttributeUpdate, ExpectedValue, KeySchema, PathSegment, PutExpectation, RangeCondition, RangeOp,
};
use super::wire::{WireItem, from_wire};
use crate::error::{AppError, AppResult};

pub const DEFAULT_LIMIT: i32 = 100;
pub const MAX_LIMIT: i32 = 1000;
const BASE_PREFIX: &str = "dbk";

/// Expression parts ready for a Query/Scan/PutItem request. Empty maps must not be sent.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Expressions {
    pub key_condition: Option<String>,
    pub filter: Option<String>,
    pub condition: Option<String>,
    pub update: Option<String>,
    pub names: HashMap<String, String>,
    pub values: HashMap<String, AttributeValue>,
}

impl Expressions {
    pub fn names_or_none(&self) -> Option<HashMap<String, String>> {
        (!self.names.is_empty()).then(|| self.names.clone())
    }

    pub fn values_or_none(&self) -> Option<HashMap<String, AttributeValue>> {
        (!self.values.is_empty()).then(|| self.values.clone())
    }
}

/// User placeholders from a request.
#[derive(Debug, Clone, Copy, Default)]
pub struct UserParts<'a> {
    pub filter: Option<&'a str>,
    pub names: Option<&'a BTreeMap<String, String>>,
    pub values: Option<&'a WireItem>,
}

/// Page size: default 100, values above 1000 are capped, values below 1 are rejected.
pub fn page_limit(limit: Option<i64>) -> AppResult<i32> {
    match limit {
        None => Ok(DEFAULT_LIMIT),
        Some(n) if n < 1 => {
            Err(AppError::InvalidInput(format!("limit must be at least 1, got {n}")))
        }
        Some(n) => Ok(i32::try_from(n.min(i64::from(MAX_LIMIT))).unwrap_or(MAX_LIMIT)),
    }
}

/// A prefix no user placeholder starts with (after its `#` or `:`).
fn reserved_prefix(user: &UserParts<'_>) -> String {
    let keys: Vec<&str> = user
        .names
        .into_iter()
        .flat_map(|m| m.keys())
        .chain(user.values.into_iter().flat_map(|m| m.keys()))
        .map(|k| k.get(1..).unwrap_or(""))
        .collect();
    let mut prefix = BASE_PREFIX.to_string();
    while keys.iter().any(|k| k.starts_with(prefix.as_str())) {
        prefix.push('_');
    }
    prefix
}

fn user_base(user: &UserParts<'_>) -> AppResult<Expressions> {
    let names = user.names.cloned().unwrap_or_default();
    if let Some(bad) = names.keys().find(|k| !k.starts_with('#') || k.len() < 2) {
        return Err(AppError::InvalidInput(format!(
            "expression attribute name placeholder must look like #name: {bad:?}"
        )));
    }
    let mut values = HashMap::new();
    for (key, value) in user.values.into_iter().flatten() {
        if !key.starts_with(':') || key.len() < 2 {
            return Err(AppError::InvalidInput(format!(
                "expression attribute value placeholder must look like :value: {key:?}"
            )));
        }
        values.insert(key.clone(), from_wire(value)?);
    }
    let filter = user.filter.map(str::trim).filter(|f| !f.is_empty()).map(str::to_string);
    Ok(Expressions { filter, names: names.into_iter().collect(), values, ..Default::default() })
}

fn range_clause(
    condition: &RangeCondition,
    name: &str,
    value: &str,
    values: &mut HashMap<String, AttributeValue>,
) -> AppResult<String> {
    Ok(match condition {
        RangeCondition::Between { from, to, .. } => {
            let (low, high) = (format!("{value}a"), format!("{value}b"));
            values.insert(low.clone(), from_wire(from)?);
            values.insert(high.clone(), from_wire(to)?);
            format!("{name} BETWEEN {low} AND {high}")
        }
        RangeCondition::Compare { op, value: wire } => {
            values.insert(value.to_string(), from_wire(wire)?);
            match op {
                RangeOp::Eq => format!("{name} = {value}"),
                RangeOp::Lt => format!("{name} < {value}"),
                RangeOp::Le => format!("{name} <= {value}"),
                RangeOp::Gt => format!("{name} > {value}"),
                RangeOp::Ge => format!("{name} >= {value}"),
                RangeOp::BeginsWith => format!("begins_with({name}, {value})"),
            }
        }
    })
}

/// Query: `#p0 = :p0 [AND <range clause on #p1/:p1>]` plus the user filter.
pub fn build_query(
    schema: &KeySchema,
    hash: &Value,
    range: Option<&RangeCondition>,
    user: &UserParts<'_>,
) -> AppResult<Expressions> {
    let prefix = reserved_prefix(user);
    let base = user_base(user)?;
    let mut names = base.names.clone();
    let mut values = base.values.clone();
    let (hash_name, hash_value) = (format!("#{prefix}0"), format!(":{prefix}0"));
    names.insert(hash_name.clone(), schema.hash.name.clone());
    values.insert(hash_value.clone(), from_wire(hash)?);
    let mut key_condition = format!("{hash_name} = {hash_value}");
    if let Some(condition) = range {
        let range_key = schema.range.as_ref().ok_or_else(|| {
            AppError::InvalidInput(format!(
                "a range condition was given but the key schema has no range key (hash key {})",
                schema.hash.name
            ))
        })?;
        let (range_name, range_value) = (format!("#{prefix}1"), format!(":{prefix}1"));
        names.insert(range_name.clone(), range_key.name.clone());
        let clause = range_clause(condition, &range_name, &range_value, &mut values)?;
        key_condition = format!("{key_condition} AND {clause}");
    }
    Ok(Expressions { key_condition: Some(key_condition), names, values, ..base })
}

/// Scan: only the user filter and its placeholders.
pub fn build_scan(user: &UserParts<'_>) -> AppResult<Expressions> {
    user_base(user)
}

/// `#{attr}` for the attribute, then `.#{attr}_{j}` for every map key and `[n]` for every list
/// index below it. Map keys travel as placeholders like attribute names.
fn path_expression(
    attr: &str,
    name: &str,
    path: &[PathSegment],
    names: &mut HashMap<String, String>,
) -> AppResult<String> {
    if name.is_empty() {
        return Err(AppError::InvalidInput("attribute name must not be empty".into()));
    }
    let attr = format!("#{attr}");
    names.insert(attr.clone(), name.to_string());
    let mut expression = attr.clone();
    for (j, segment) in path.iter().enumerate() {
        match segment {
            PathSegment::Index(index) => expression.push_str(&format!("[{index}]")),
            PathSegment::Key(key) if key.is_empty() => {
                return Err(AppError::InvalidInput(format!(
                    "a map key in {} is empty",
                    display_path(name, path)
                )));
            }
            PathSegment::Key(key) => {
                let placeholder = format!("{attr}_{j}");
                names.insert(placeholder.clone(), key.clone());
                expression.push('.');
                expression.push_str(&placeholder);
            }
        }
    }
    Ok(expression)
}

/// `<path> = :dbkcN`, or `attribute_not_exists(<path>)` for a value that must be missing, per
/// expected value. Repeated ones (several edits in one list) are sent once.
fn expected_clauses(
    expected: &[ExpectedValue],
    names: &mut HashMap<String, String>,
    values: &mut HashMap<String, AttributeValue>,
) -> AppResult<Vec<String>> {
    let mut clauses = Vec::with_capacity(expected.len());
    for (i, condition) in expected.iter().enumerate() {
        if expected[..i].contains(condition) {
            continue;
        }
        let attr = format!("{BASE_PREFIX}c{i}");
        let path = path_expression(&attr, &condition.name, &condition.path, names)?;
        clauses.push(match &condition.value {
            Some(value) => {
                let placeholder = format!(":{attr}");
                values.insert(placeholder.clone(), from_wire(value)?);
                format!("{path} = {placeholder}")
            }
            None => format!("attribute_not_exists({path})"),
        });
    }
    Ok(clauses)
}

/// PutItem condition for `expect`. Saving over an existing item can also require values it
/// must still hold (see `ExpectedValue`); creating an item can't, as there is nothing to hold.
pub fn put_condition(
    expect: PutExpectation,
    hash_key: &str,
    expected: &[ExpectedValue],
) -> AppResult<Expressions> {
    if !expected.is_empty() && expect != PutExpectation::Exists {
        return Err(AppError::InvalidInput(
            "expected values need a save over an existing item (expect: exists)".into(),
        ));
    }
    let name = format!("#{BASE_PREFIX}0");
    let condition = match expect {
        PutExpectation::Any => return Ok(Expressions::default()),
        PutExpectation::Exists => format!("attribute_exists({name})"),
        PutExpectation::NotExists => format!("attribute_not_exists({name})"),
    };
    let mut names = HashMap::from([(name, hash_key.to_string())]);
    let mut values = HashMap::new();
    let clauses = expected_clauses(expected, &mut names, &mut values)?;
    Ok(Expressions {
        condition: Some([condition].into_iter().chain(clauses).collect::<Vec<_>>().join(" AND ")),
        names,
        values,
        ..Default::default()
    })
}

/// A document path such as `tags.list[0]`, for error messages only.
fn display_path(name: &str, path: &[PathSegment]) -> String {
    path.iter().fold(name.to_string(), |text, segment| match segment {
        PathSegment::Index(i) => format!("{text}[{i}]"),
        PathSegment::Key(key) => format!("{text}.{key}"),
    })
}

/// Whether `a` is `b` or lies inside it (or the other way round). DynamoDB refuses an update
/// whose paths overlap like that, so it is reported before sending.
fn paths_overlap(a: &AttributeUpdate, b: &AttributeUpdate) -> bool {
    a.name == b.name && a.path.iter().zip(&b.path).all(|(x, y)| x == y)
}

/// UpdateItem for inline edits: `SET <path0> = :dbkv0, ...` with the condition
/// `attribute_exists(#dbk0)` (the item is still there), per change `<pathN> = :dbkeN` (still the
/// value the user saw) or `attribute_not_exists(#dbkaN)` (an attribute still missing), and every
/// `expected` value (the lists the paths index into, see `ExpectedValue`). A path is the
/// attribute, or a value nested in its maps and lists (see `path_expression`). Names, map keys
/// and values only ever travel as placeholders. Key attributes can't be set this way.
pub fn build_update(
    schema: &KeySchema,
    changes: &[AttributeUpdate],
    expected: &[ExpectedValue],
) -> AppResult<Expressions> {
    if changes.is_empty() {
        return Err(AppError::InvalidInput("no attribute changes to apply".into()));
    }
    let key_name = format!("#{BASE_PREFIX}0");
    let mut names = HashMap::from([(key_name.clone(), schema.hash.name.clone())]);
    let mut values = HashMap::new();
    let mut sets = Vec::with_capacity(changes.len());
    let mut conditions = vec![format!("attribute_exists({key_name})")];
    for (i, change) in changes.iter().enumerate() {
        let name = change.name.as_str();
        if name == schema.hash.name || schema.range.as_ref().is_some_and(|r| r.name == name) {
            return Err(AppError::InvalidInput(format!(
                "{name} is part of the table key; edit the item as JSON to change it"
            )));
        }
        if changes[..i].iter().any(|earlier| paths_overlap(earlier, change)) {
            return Err(AppError::InvalidInput(format!(
                "{} is changed twice",
                display_path(name, &change.path)
            )));
        }
        let path = path_expression(&format!("{BASE_PREFIX}a{i}"), name, &change.path, &mut names)?;
        let value = format!(":{BASE_PREFIX}v{i}");
        values.insert(value.clone(), from_wire(&change.value)?);
        sets.push(format!("{path} = {value}"));
        conditions.push(match &change.expected {
            Some(expected) => {
                let placeholder = format!(":{BASE_PREFIX}e{i}");
                values.insert(placeholder.clone(), from_wire(expected)?);
                format!("{path} = {placeholder}")
            }
            // Missing inside a map or list is no guard: `SET #a[7]` past the end appends.
            None if !change.path.is_empty() => {
                return Err(AppError::InvalidInput(format!(
                    "{} needs the value it is expected to replace",
                    display_path(name, &change.path)
                )));
            }
            None => format!("attribute_not_exists({path})"),
        });
    }
    conditions.extend(expected_clauses(expected, &mut names, &mut values)?);
    Ok(Expressions {
        update: Some(format!("SET {}", sets.join(", "))),
        condition: Some(conditions.join(" AND ")),
        names,
        values,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dynamo::model::{BetweenOp, KeyAttribute, KeyType};
    use serde_json::json;

    fn schema(range: bool) -> KeySchema {
        KeySchema {
            hash: KeyAttribute { name: "pk".into(), key_type: KeyType::S },
            range: range.then(|| KeyAttribute { name: "sk".into(), key_type: KeyType::N }),
        }
    }

    fn compare(op: RangeOp) -> RangeCondition {
        RangeCondition::Compare { op, value: json!({ "N": "5" }) }
    }

    #[test]
    fn query_without_range() {
        let e =
            build_query(&schema(true), &json!({ "S": "a" }), None, &UserParts::default()).unwrap();
        assert_eq!(e.key_condition.as_deref(), Some("#dbk0 = :dbk0"));
        assert_eq!(e.names, HashMap::from([("#dbk0".to_string(), "pk".to_string())]));
        assert_eq!(e.values[":dbk0"], AttributeValue::S("a".into()));
        assert_eq!(e.filter, None);
    }

    #[test]
    fn query_range_operators() {
        let cases = [
            (RangeOp::Eq, "#dbk1 = :dbk1"),
            (RangeOp::Lt, "#dbk1 < :dbk1"),
            (RangeOp::Le, "#dbk1 <= :dbk1"),
            (RangeOp::Gt, "#dbk1 > :dbk1"),
            (RangeOp::Ge, "#dbk1 >= :dbk1"),
            (RangeOp::BeginsWith, "begins_with(#dbk1, :dbk1)"),
        ];
        for (op, clause) in cases {
            let e = build_query(
                &schema(true),
                &json!({ "S": "a" }),
                Some(&compare(op)),
                &UserParts::default(),
            )
            .unwrap();
            assert_eq!(e.key_condition.unwrap(), format!("#dbk0 = :dbk0 AND {clause}"));
            assert_eq!(e.names["#dbk1"], "sk");
            assert_eq!(e.values[":dbk1"], AttributeValue::N("5".into()));
        }
        let between = RangeCondition::Between {
            op: BetweenOp::Between,
            from: json!({ "N": "1" }),
            to: json!({ "N": "9" }),
        };
        let e =
            build_query(&schema(true), &json!({ "S": "a" }), Some(&between), &UserParts::default())
                .unwrap();
        assert_eq!(e.key_condition.unwrap(), "#dbk0 = :dbk0 AND #dbk1 BETWEEN :dbk1a AND :dbk1b");
        assert_eq!(e.values[":dbk1b"], AttributeValue::N("9".into()));
    }

    #[test]
    fn range_without_range_key_is_invalid() {
        let err = build_query(
            &schema(false),
            &json!({ "S": "a" }),
            Some(&compare(RangeOp::Eq)),
            &UserParts::default(),
        )
        .unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
    }

    #[test]
    fn user_placeholders_pass_through_and_never_collide() {
        let names = BTreeMap::from([("#dbk0".to_string(), "status".to_string())]);
        let values: WireItem = serde_json::from_value(json!({ ":dbk_x": { "S": "on" } })).unwrap();
        let user = UserParts {
            filter: Some("  #dbk0 = :dbk_x "),
            names: Some(&names),
            values: Some(&values),
        };
        let e =
            build_query(&schema(true), &json!({ "S": "a" }), Some(&compare(RangeOp::Gt)), &user)
                .unwrap();
        assert_eq!(e.filter.as_deref(), Some("#dbk0 = :dbk_x"));
        assert_eq!(e.key_condition.unwrap(), "#dbk__0 = :dbk__0 AND #dbk__1 > :dbk__1");
        assert_eq!(e.names["#dbk0"], "status");
        assert_eq!(e.names["#dbk__0"], "pk");
        assert_eq!(e.values[":dbk_x"], AttributeValue::S("on".into()));
        assert_eq!(e.names.len(), 3);
        assert_eq!(e.values.len(), 3);
    }

    #[test]
    fn scan_uses_only_user_parts() {
        let e = build_scan(&UserParts { filter: Some(" "), ..Default::default() }).unwrap();
        assert_eq!(e, Expressions::default());
        assert_eq!(e.names_or_none(), None);
        let bad_names = BTreeMap::from([("n".to_string(), "x".to_string())]);
        let err =
            build_scan(&UserParts { names: Some(&bad_names), ..Default::default() }).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        let bad_values: WireItem = serde_json::from_value(json!({ "v": { "S": "x" } })).unwrap();
        let err =
            build_scan(&UserParts { values: Some(&bad_values), ..Default::default() }).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        let bad_wire: WireItem = serde_json::from_value(json!({ ":v": { "S": 1 } })).unwrap();
        let err =
            build_scan(&UserParts { values: Some(&bad_wire), ..Default::default() }).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
    }

    #[test]
    fn put_conditions() {
        assert_eq!(put_condition(PutExpectation::Any, "pk", &[]).unwrap(), Expressions::default());
        let e = put_condition(PutExpectation::Exists, "pk", &[]).unwrap();
        assert_eq!(e.condition.as_deref(), Some("attribute_exists(#dbk0)"));
        assert_eq!(e.names["#dbk0"], "pk");
        let e = put_condition(PutExpectation::NotExists, "pk", &[]).unwrap();
        assert_eq!(e.condition.as_deref(), Some("attribute_not_exists(#dbk0)"));
    }

    fn change(name: &str, value: Value, expected: Option<Value>) -> AttributeUpdate {
        AttributeUpdate { name: name.into(), path: vec![], value, expected }
    }

    fn nested(
        name: &str,
        path: &[Value],
        value: Value,
        expected: Option<Value>,
    ) -> AttributeUpdate {
        let path = path.iter().map(|s| serde_json::from_value(s.clone()).unwrap()).collect();
        AttributeUpdate { name: name.into(), path, value, expected }
    }

    #[test]
    fn update_sets_through_placeholders_with_value_conditions() {
        let changes = [
            change("status", json!({ "S": "on" }), Some(json!({ "S": "off" }))),
            change("count", json!({ "N": "2" }), None),
        ];
        let e = build_update(&schema(true), &changes, &[]).unwrap();
        assert_eq!(e.update.as_deref(), Some("SET #dbka0 = :dbkv0, #dbka1 = :dbkv1"));
        assert_eq!(
            e.condition.as_deref(),
            Some("attribute_exists(#dbk0) AND #dbka0 = :dbke0 AND attribute_not_exists(#dbka1)")
        );
        assert_eq!(e.names["#dbk0"], "pk");
        assert_eq!(e.names["#dbka0"], "status");
        assert_eq!(e.names["#dbka1"], "count");
        assert_eq!(e.values[":dbkv0"], AttributeValue::S("on".into()));
        assert_eq!(e.values[":dbke0"], AttributeValue::S("off".into()));
        assert_eq!(e.values[":dbkv1"], AttributeValue::N("2".into()));
        assert_eq!(e.values.len(), 3);
        assert_eq!(e.key_condition, None);
    }

    #[test]
    fn update_keeps_odd_attribute_names_out_of_the_expression() {
        let name = "a = :x OR #y";
        let changes = [change(name, json!({ "BOOL": true }), Some(json!({ "BOOL": false })))];
        let e = build_update(&schema(false), &changes, &[]).unwrap();
        assert!(!e.update.unwrap().contains(name));
        assert!(!e.condition.unwrap().contains(name));
        assert_eq!(e.names["#dbka0"], name);
    }

    #[test]
    fn update_rejects_keys_duplicates_bad_values_and_nothing() {
        let s = schema(true);
        let cases = [
            vec![],
            vec![change("pk", json!({ "S": "x" }), None)],
            vec![change("sk", json!({ "N": "1" }), None)],
            vec![change("", json!({ "S": "x" }), None)],
            vec![change("a", json!({ "S": "x" }), None), change("a", json!({ "S": "y" }), None)],
            vec![change("a", json!({ "N": 1 }), None)],
            vec![change("a", json!({ "S": "x" }), Some(json!({ "Q": "?" })))],
            vec![nested("pk", &[json!("x")], json!({ "S": "x" }), None)],
            vec![nested("a", &[json!("")], json!({ "S": "x" }), None)],
            vec![
                nested("a", &[json!("b"), json!(0)], json!({ "S": "x" }), None),
                nested("a", &[json!("b"), json!(0)], json!({ "S": "y" }), None),
            ],
            // A value and one inside it overlap, in either order.
            vec![
                change("a", json!({ "M": {} }), None),
                nested("a", &[json!("b")], json!({ "S": "y" }), None),
            ],
            vec![
                nested("a", &[json!("b"), json!(1)], json!({ "S": "y" }), None),
                nested("a", &[json!("b")], json!({ "L": [] }), None),
            ],
        ];
        for changes in cases {
            let err = build_update(&s, &changes, &[]).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{changes:?}");
        }
    }

    #[test]
    fn update_sets_nested_values_through_placeholders() {
        let changes = [
            nested(
                "service",
                &[json!("numbers"), json!(0), json!("sender")],
                json!({ "S": "02" }),
                Some(json!({ "S": "01" })),
            ),
            nested(
                "service",
                &[json!("numbers"), json!(1)],
                json!({ "N": "2" }),
                Some(json!({ "N": "1" })),
            ),
            change("note", json!({ "S": "n" }), Some(json!({ "S": "m" }))),
        ];
        let e = build_update(&schema(true), &changes, &[]).unwrap();
        assert_eq!(
            e.update.as_deref(),
            Some(
                "SET #dbka0.#dbka0_0[0].#dbka0_2 = :dbkv0, #dbka1.#dbka1_0[1] = :dbkv1, \
                 #dbka2 = :dbkv2"
            )
        );
        assert_eq!(
            e.condition.as_deref(),
            Some(
                "attribute_exists(#dbk0) AND #dbka0.#dbka0_0[0].#dbka0_2 = :dbke0 \
                 AND #dbka1.#dbka1_0[1] = :dbke1 AND #dbka2 = :dbke2"
            )
        );
        assert_eq!(e.names["#dbka0"], "service");
        assert_eq!(e.names["#dbka0_0"], "numbers");
        assert_eq!(e.names["#dbka0_2"], "sender");
        assert_eq!(e.names["#dbka1_0"], "numbers");
        assert_eq!(e.values[":dbke0"], AttributeValue::S("01".into()));
        assert_eq!(e.values[":dbkv1"], AttributeValue::N("2".into()));
    }

    #[test]
    fn update_refuses_a_nested_value_without_the_value_it_replaces() {
        // `attribute_not_exists(#a[7])` holds and `SET #a[7]` would append to the list.
        let changes = [nested("a", &[json!(7)], json!({ "S": "x" }), None)];
        let err = build_update(&schema(false), &changes, &[]).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("a[7]"), "{err}");
    }

    fn expected(name: &str, path: &[Value], value: Option<Value>) -> ExpectedValue {
        let path = path.iter().map(|s| serde_json::from_value(s.clone()).unwrap()).collect();
        ExpectedValue { name: name.into(), path, value }
    }

    #[test]
    fn update_guards_the_lists_on_its_paths_once_each() {
        let rules = json!({ "L": [{ "M": { "on": { "BOOL": false }, "n": { "N": "1" } } }] });
        let changes = [
            nested(
                "rules",
                &[json!(0), json!("on")],
                json!({ "BOOL": true }),
                Some(json!({ "BOOL": false })),
            ),
            nested(
                "rules",
                &[json!(0), json!("n")],
                json!({ "N": "2" }),
                Some(json!({ "N": "1" })),
            ),
        ];
        let guards = [
            expected("rules", &[], Some(rules.clone())),
            expected("rules", &[], Some(rules)),
            expected("gone", &[], None),
        ];
        let e = build_update(&schema(false), &changes, &guards).unwrap();
        assert_eq!(
            e.condition.as_deref(),
            Some(
                "attribute_exists(#dbk0) AND #dbka0[0].#dbka0_1 = :dbke0 \
                 AND #dbka1[0].#dbka1_1 = :dbke1 AND #dbkc0 = :dbkc0 \
                 AND attribute_not_exists(#dbkc2)"
            )
        );
        assert_eq!(e.names["#dbkc0"], "rules");
        assert_eq!(e.names["#dbkc2"], "gone");
        assert!(matches!(e.values[":dbkc0"], AttributeValue::L(_)));
        assert!(!e.values.contains_key(":dbkc1"));
        let bad = [expected("", &[], None)];
        assert_eq!(
            build_update(&schema(false), &changes, &bad).unwrap_err().kind(),
            "invalid_input"
        );
    }

    #[test]
    fn put_requires_expected_values_only_over_an_existing_item() {
        let guards = [expected("rules", &[json!(1), json!("on")], Some(json!({ "BOOL": true })))];
        let e = put_condition(PutExpectation::Exists, "pk", &guards).unwrap();
        assert_eq!(
            e.condition.as_deref(),
            Some("attribute_exists(#dbk0) AND #dbkc0[1].#dbkc0_1 = :dbkc0")
        );
        assert_eq!(e.names["#dbkc0_1"], "on");
        for expect in [PutExpectation::NotExists, PutExpectation::Any] {
            assert_eq!(put_condition(expect, "pk", &guards).unwrap_err().kind(), "invalid_input");
        }
    }

    #[test]
    fn update_keeps_odd_map_keys_out_of_the_expression() {
        let key = "x.y[0] = :v OR #z";
        let changes = [nested("m", &[json!(key)], json!({ "S": "b" }), Some(json!({ "S": "a" })))];
        let e = build_update(&schema(false), &changes, &[]).unwrap();
        assert!(!e.update.unwrap().contains(key));
        assert!(!e.condition.unwrap().contains(key));
        assert_eq!(e.names["#dbka0_0"], key);
    }

    #[test]
    fn limits() {
        assert_eq!(page_limit(None).unwrap(), 100);
        assert_eq!(page_limit(Some(1)).unwrap(), 1);
        assert_eq!(page_limit(Some(5000)).unwrap(), 1000);
        assert_eq!(page_limit(Some(0)).unwrap_err().kind(), "invalid_input");
        assert_eq!(page_limit(Some(-3)).unwrap_err().kind(), "invalid_input");
    }
}
