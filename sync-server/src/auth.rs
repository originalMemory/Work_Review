use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::Response,
};

/// Bearer token 校验中间件
pub async fn auth_middleware(request: Request, next: Next) -> Result<Response, StatusCode> {
    let expected_token = std::env::var("SYNC_TOKEN").unwrap_or_default();
    if expected_token.is_empty() {
        tracing::warn!("SYNC_TOKEN 未设置，所有请求将被放行");
        return Ok(next.run(request).await);
    }

    let auth_header = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok());

    match auth_header {
        Some(header) if header.starts_with("Bearer ") => {
            let token = &header[7..];
            if token == expected_token {
                Ok(next.run(request).await)
            } else {
                Err(StatusCode::UNAUTHORIZED)
            }
        }
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}
