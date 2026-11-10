use tia_launcher::game::policy::requires_update;
#[test]
fn minimum_launcher_versions_compare_numerically_and_accept_legacy_four_parts() {
    for (minimum, current, expected) in [
        ("", "2.0.2", false),
        ("2.0.2", "2.0.2", false),
        ("2.0.2.0", "2.0.2", false),
        ("2.0.2.1", "2.0.2", true),
        ("2.10.0", "2.9.9", true),
        ("1.19.2", "2.0.2", false),
    ] {
        assert_eq!(requires_update(minimum, current).unwrap(), expected);
    }
    for invalid in [
        "2",
        "2.0",
        "2.0.x",
        "2.0.0-rc1",
        "2.0.0.0.1",
        "2.0.18446744073709551616",
    ] {
        assert!(requires_update(invalid, "2.0.2").is_err());
    }
}
