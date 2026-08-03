mod auth;
mod db;
mod models;
mod sync_api;

use axum::{
    extract::DefaultBodyLimit,
    middleware,
    routing::{get, post, put},
    Router,
};
use clap::Parser;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

#[derive(Parser)]
#[command(name = "sync-server", about = "Work Review 多设备同步服务")]
struct Args {
    /// 数据存储目录
    #[arg(long, default_value = "/data")]
    data_dir: PathBuf,

    /// 监听端口
    #[arg(long, default_value_t = 8080)]
    port: u16,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "sync_server=info,tower_http=info".into()),
        )
        .init();

    let args = Args::parse();
    std::env::var("SYNC_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
        .expect("必须设置非空的 SYNC_TOKEN，服务拒绝无鉴权启动");
    tracing::info!("数据目录: {:?}", args.data_dir);

    let database = db::Database::new(&args.data_dir);

    let (acts, reports, summaries, devices) = database.storage_stats();
    tracing::info!(
        "存储统计: {} 条活动, {} 份日报, {} 条摘要, {} 台设备",
        acts,
        reports,
        summaries,
        devices
    );

    let state = Arc::new(sync_api::ServerState {
        db: database,
        data_dir: args.data_dir,
    });

    // Axum 默认 body 上限约 2MB；增量 push 可能含大量 OCR 文本，需放宽。
    const PUSH_BODY_LIMIT: usize = 32 * 1024 * 1024;

    let api_routes = Router::new()
        .route(
            "/api/sync/push",
            post(sync_api::push).layer(DefaultBodyLimit::max(PUSH_BODY_LIMIT)),
        )
        .route("/api/sync/pull", get(sync_api::pull))
        .route(
            "/api/sync/screenshot/{device_id}/{date}/{filename}",
            put(sync_api::upload_screenshot)
                .layer(DefaultBodyLimit::max(10 * 1024 * 1024))
                .get(sync_api::download_screenshot),
        )
        .route(
            "/api/sync/screenshot/prune/{device_id}/{date}",
            post(sync_api::prune_screenshots_for_day),
        )
        .route("/api/devices/register", post(sync_api::register_device))
        .route("/api/devices", get(sync_api::list_devices))
        .layer(middleware::from_fn(auth::auth_middleware));

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(api_routes)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = format!("0.0.0.0:{}", args.port);
    tracing::info!("sync-server 启动: http://{addr}");

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("端口绑定失败");
    axum::serve(listener, app).await.expect("服务异常退出");
}
