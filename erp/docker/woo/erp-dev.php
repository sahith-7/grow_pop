<?php
// DEV ONLY (docker-compose.woo.yml). Never install this on a real shop.
// Lets WooCommerce deliver webhooks to the ERP's api container on the private Docker network (port 4000), and sends
// them during the request instead of from WP-Cron, which a shop with no visitors rarely runs.
add_filter('http_request_host_is_external', '__return_true');
add_filter('http_allowed_safe_ports', function ($ports) { $ports[] = 4000; return $ports; });
add_filter('woocommerce_webhook_deliver_async', '__return_false');
