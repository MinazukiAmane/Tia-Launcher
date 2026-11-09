pub fn bottom_right(
    origin: (i32, i32),
    area: (u32, u32),
    window: (u32, u32),
    margin: u32,
) -> (i32, i32) {
    let axis = |position: i32, available: u32, size: u32| {
        (i64::from(position) + (i64::from(available) - i64::from(size) - i64::from(margin)).max(0))
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
    };
    (
        axis(origin.0, area.0, window.0),
        axis(origin.1, area.1, window.1),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn respects_negative_monitor_origins_and_scaled_window_size() {
        assert_eq!(
            bottom_right((0, 0), (1920, 1040), (236, 100), 24),
            (1660, 916)
        );
        assert_eq!(
            bottom_right((-1920, 0), (1920, 1080), (472, 200), 48),
            (-520, 832)
        );
        assert_eq!(
            bottom_right((10, -900), (1280, 900), (236, 100), 24),
            (1030, -124)
        );
        assert_eq!(bottom_right((0, 0), (100, 80), (236, 100), 24), (0, 0));
    }
}
