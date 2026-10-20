//! Builds KeyCondition/Filter/Condition expressions and their attribute maps.
//!
//! User supplied placeholders (`#n`, `:v`) are passed through untouched. Placeholders generated
//! here use a prefix (`#dbk0`, `:dbk0` ...) that is lengthened with `_` until no user placeholder
//! starts with it, so the two sets can never collide.

use std::collections::{BTreeMap, HashMap, HashSet};

use aws_sdk_dynamodb::types::AttributeValue;
use serde_json::Value;

use super::model::{AttributeUpdate, KeySchema, PutExpectation, RangeCondition, RangeOp};
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

/// PutItem condition for `expect`.
pub fn put_condition(expect: PutExpectation, hash_key: &str) -> Expressions {
    let name = format!("#{BASE_PREFIX}0");
    let condition = match expect {
        PutExpectation::Any => return Expressions::default(),
        PutExpectation::Exists => format!("attribute_exists({name})"),
        PutExpectation::NotExists => format!("attribute_not_exists({name})"),
    };
    Expressions {
        condition: Some(condition),
        names: HashMap::from([(name, hash_key.to_string())]),
        ..Default::default()
    }
}

/// UpdateItem for inline grid edits: `SET #dbka0 = :dbkv0, ...` with the condition
/// `attribute_exists(#dbk0)` (the item is still there) and, per attribute, `#dbkaN = :dbkeN`
/// (still the value the user saw) or `attribute_not_exists(#dbkaN)` (still missing). Names and
/// values only ever travel as placeholders. Key attributes can't be set this way.
pub fn build_update(schema: &KeySchema, changes: &[AttributeUpdate]) -> AppResult<Expressions> {
    if changes.is_empty() {
        return Err(AppError::InvalidInput("no attribute changes to apply".into()));
    }
    let key_name = format!("#{BASE_PREFIX}0");
    let mut names = HashMap::from([(key_name.clone(), schema.hash.name.clone())]);
    let mut values = HashMap::new();
    let mut sets = Vec::with_capacity(changes.len());
    let mut conditions = vec![format!("attribute_exists({key_name})")];
    let mut seen = HashSet::new();
    for (i, change) in changes.iter().enumerate() {
        let name = change.name.as_str();
        if name.is_empty() {
            return Err(AppError::InvalidInput("attribute name must not be empty".into()));
        }
        if name == schema.hash.name || schema.range.as_ref().is_some_and(|r| r.name == name) {
            return Err(AppError::InvalidInput(format!(
                "{name} is part of the table key; edit the item as JSON to change it"
            )));
        }
        if !seen.insert(name) {
            return Err(AppError::InvalidInput(format!("attribute {name} is changed twice")));
        }
        let (attr, value) = (format!("#{BASE_PREFIX}a{i}"), format!(":{BASE_PREFIX}v{i}"));
        names.insert(attr.clone(), name.to_string());
        values.insert(value.clone(), from_wire(&change.value)?);
        sets.push(format!("{attr} = {value}"));
        conditions.push(match &change.expected {
            Some(expected) => {
                let placeholder = format!(":{BASE_PREFIX}e{i}");
                values.insert(placeholder.clone(), from_wire(expected)?);
                format!("{attr} = {placeholder}")
            }
            None => format!("attribute_not_exists({attr})"),
        });
    }
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
        assert_eq!(put_condition(PutExpectation::Any, "pk"), Expressions::default());
        let e = put_condition(PutExpectation::Exists, "pk");
        assert_eq!(e.condition.as_deref(), Some("attribute_exists(#dbk0)"));
        assert_eq!(e.names["#dbk0"], "pk");
        let e = put_condition(PutExpectation::NotExists, "pk");
        assert_eq!(e.condition.as_deref(), Some("attribute_not_exists(#dbk0)"));
    }

    fn change(name: &str, value: Value, expected: Option<Value>) -> AttributeUpdate {
        AttributeUpdate { name: name.into(), value, expected }
    }

    #[test]
    fn update_sets_through_placeholders_with_value_conditions() {
        let changes = [
            change("status", json!({ "S": "on" }), Some(json!({ "S": "off" }))),
            change("count", json!({ "N": "2" }), None),
        ];
        let e = build_update(&schema(true), &changes).unwrap();
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
        let e = build_update(&schema(false), &changes).unwrap();
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
        ];
        for changes in cases {
            let err = build_update(&s, &changes).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{changes:?}");
        }
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
