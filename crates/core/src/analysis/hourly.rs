// 小时摘要生成器：按小时聚合活动，供时间线小时摘要使用。

use crate::database::Activity;
use std::collections::HashMap;

fn calculate_activity_covered_duration(activities: &[Activity]) -> i64 {
    let mut ranges = activities
        .iter()
        .filter_map(|activity| {
            if activity.duration <= 0 {
                return None;
            }

            let start = activity.timestamp.saturating_sub(activity.duration);
            let end = activity.timestamp;
            (end > start).then_some((start, end))
        })
        .collect::<Vec<_>>();

    if ranges.is_empty() {
        return 0;
    }

    ranges.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));

    let mut total = 0;
    let mut current_start = ranges[0].0;
    let mut current_end = ranges[0].1;

    for (start, end) in ranges.into_iter().skip(1) {
        if start <= current_end {
            current_end = current_end.max(end);
        } else {
            total += current_end - current_start;
            current_start = start;
            current_end = end;
        }
    }

    total + (current_end - current_start)
}

/// 小时活动统计
#[derive(Debug, Clone)]
pub struct HourlyStats {
    app_durations: HashMap<String, i64>,
    pub total_duration: i64,
    pub activity_count: i32,
    pub representative_screenshots: Vec<String>,
    pub urls: Vec<String>,
    pub ocr_keywords: Vec<String>,
}

impl HourlyStats {
    /// 从活动列表构建统计
    pub fn from_activities(activities: Vec<Activity>) -> Self {
        let mut app_durations: HashMap<String, i64> = HashMap::new();
        let mut representative_screenshots = Vec::new();
        let mut urls = Vec::new();
        let mut last_app: Option<String> = None;

        // 先计算 activity_count
        let activity_count = activities.len() as i32;

        for activity in &activities {
            // 统计应用时长
            *app_durations.entry(activity.app_name.clone()).or_insert(0) += activity.duration;

            // 收集浏览器 URL
            if let Some(url) = &activity.browser_url {
                if !url.is_empty() && !urls.contains(url) {
                    urls.push(url.clone());
                }
            }

            // 挑选代表性截图（应用切换时的截图）
            let current_app = Some(activity.app_name.clone());
            if current_app != last_app && !activity.screenshot_path.is_empty() {
                representative_screenshots.push(activity.screenshot_path.clone());
            }
            last_app = current_app;
        }

        // 限制代表性截图数量
        if representative_screenshots.len() > 5 {
            representative_screenshots = representative_screenshots.into_iter().take(5).collect();
        }

        // 提取 OCR 关键词
        let mut ocr_keywords: Vec<String> = Vec::new();
        let mut seen_keywords: std::collections::HashSet<String> = std::collections::HashSet::new();
        for activity in &activities {
            if let Some(ocr_text) = &activity.ocr_text {
                // 提取有意义的词（长度 > 3 的中英文词）
                for word in ocr_text.split(|c: char| !c.is_alphanumeric() && c != '-') {
                    let word = word.trim();
                    if word.chars().count() >= 2
                        && word.chars().count() <= 20
                        && !seen_keywords.contains(word)
                    {
                        // 只保留中文或英文词
                        if word.chars().all(|c| c.is_alphabetic() || c >= '\u{4e00}') {
                            seen_keywords.insert(word.to_string());
                            ocr_keywords.push(word.to_string());
                            if ocr_keywords.len() >= 20 {
                                break;
                            }
                        }
                    }
                }
            }
            if ocr_keywords.len() >= 20 {
                break;
            }
        }

        let total_duration = calculate_activity_covered_duration(&activities);

        Self {
            app_durations,
            total_duration,
            activity_count,
            representative_screenshots,
            urls,
            ocr_keywords,
        }
    }

    /// 获取主要应用（按时长排序）
    pub fn get_main_apps(&self) -> Vec<String> {
        let mut apps: Vec<_> = self.app_durations.iter().collect();
        apps.sort_by(|a, b| b.1.cmp(a.1));
        apps.into_iter()
            .map(|(name, _)| name.clone())
            .take(5)
            .collect()
    }
}

/// 生成小时摘要（无 AI 时的备选方案）
pub fn generate_fallback_summary(stats: &HourlyStats) -> String {
    let main_apps = stats.get_main_apps();
    if main_apps.is_empty() {
        return "无活动记录".to_string();
    }

    let apps_str = main_apps.join("、");
    // 四舍五入，与前端 Math.round() 保持一致，避免 "1分钟" vs "0分钟" 的矛盾
    let duration_min = (stats.total_duration + 30) / 60;

    let mut summary = format!("使用 {apps_str} 等应用 {duration_min}分钟");

    // 添加 URL 信息（提取域名，避免完整 URL 过长导致断句）
    if !stats.urls.is_empty() {
        let domain = stats
            .urls
            .first()
            .map(|url| {
                // 提取域名部分
                url.split("//")
                    .nth(1)
                    .unwrap_or(url)
                    .split('/')
                    .next()
                    .unwrap_or(url)
                    .split(':')
                    .next()
                    .unwrap_or(url)
            })
            .unwrap_or("");
        let extra = if stats.urls.len() > 1 {
            format!(" 等 {} 个网站", stats.urls.len())
        } else {
            " 等网站".to_string()
        };
        summary.push_str(&format!("，访问了 {domain}{extra}"));
    }

    // 添加 OCR 关键词
    if !stats.ocr_keywords.is_empty() {
        let keywords_str = stats
            .ocr_keywords
            .iter()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .join("、");
        summary.push_str(&format!("，涉及: {keywords_str}"));
    }

    summary
}

#[cfg(test)]
mod tests {
    use super::{generate_fallback_summary, HourlyStats};
    use crate::database::Activity;

    fn sample_activity(app_name: &str, timestamp: i64, duration: i64) -> Activity {
        Activity {
            id: None,
            timestamp,
            app_name: app_name.to_string(),
            window_title: format!("{app_name} window"),
            screenshot_path: String::new(),
            ocr_text: None,
            category: "development".to_string(),
            duration,
            browser_url: None,
            executable_path: None,
            semantic_category: None,
            semantic_confidence: None,
            screenshot_url: None,
        }
    }

    #[test]
    fn 小时摘要总时长应按小时内覆盖时长计算而不是重叠累加() {
        let activities = vec![
            sample_activity("Chrome", 10 * 3600 + 40 * 60, 40 * 60),
            sample_activity("WeChat", 10 * 3600 + 55 * 60, 35 * 60),
        ];

        let stats = HourlyStats::from_activities(activities);

        assert_eq!(stats.total_duration, 55 * 60);
        assert!(generate_fallback_summary(&stats).contains("55分钟"));
    }
}
