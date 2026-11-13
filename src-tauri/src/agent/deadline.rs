use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct Deadline {
    end: Instant,
}

impl Deadline {
    pub fn after(duration: Duration) -> Self {
        Self {
            end: Instant::now() + duration,
        }
    }

    pub fn remaining(self) -> Duration {
        self.end.saturating_duration_since(Instant::now())
    }

    pub fn is_expired(self) -> bool {
        Instant::now() >= self.end
    }

    pub fn cap(self, max: Duration) -> Duration {
        self.remaining().min(max)
    }

    /// 从总预算里预留给收束模型调用的时间。
    /// 短超时（30s）约留 5 秒；默认 120s 留 15 秒。
    pub fn wrap_up_reserve(total: Duration) -> Duration {
        let cap = Duration::from_secs(15);
        let floor = Duration::from_secs(5);
        (total / 6).max(floor).min(cap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 已过期截止应返回零剩余() {
        let deadline = Deadline {
            end: Instant::now() - Duration::from_secs(1),
        };
        assert!(deadline.is_expired());
        assert_eq!(deadline.remaining(), Duration::ZERO);
        assert_eq!(deadline.cap(Duration::from_secs(30)), Duration::ZERO);
    }

    #[test]
    fn 收束预留应随总预算缩放并封顶() {
        assert_eq!(
            Deadline::wrap_up_reserve(Duration::from_secs(30)),
            Duration::from_secs(5)
        );
        assert_eq!(
            Deadline::wrap_up_reserve(Duration::from_secs(120)),
            Duration::from_secs(15)
        );
        assert_eq!(
            Deadline::wrap_up_reserve(Duration::from_secs(900)),
            Duration::from_secs(15)
        );
    }
}
