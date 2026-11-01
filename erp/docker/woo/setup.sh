#!/bin/sh
# DEV ONLY: install WordPress + WooCommerce once, in INR, and print a Read/Write REST key for the ERP's connect form.
set -e
cd /var/www/html
until [ -f wp-includes/version.php ] && wp db check >/dev/null 2>&1; do echo "waiting for WordPress files and database..."; sleep 3; done
if ! wp core is-installed 2>/dev/null; then
  wp core install --url="https://localhost:${WOO_PORT}" --title="Dev Shop" --admin_user=admin --admin_password=admin \
    --admin_email=admin@example.com --skip-email
fi
wp plugin is-installed woocommerce || wp plugin install woocommerce --version="${WOO_VERSION}"
wp plugin activate woocommerce
wp rewrite structure '/%postname%/'
wp option update woocommerce_currency INR
wp option update woocommerce_prices_include_tax yes
wp option update woocommerce_weight_unit kg
wp option update woocommerce_dimension_unit cm
wp option update woocommerce_coming_soon no
wp eval '
global $wpdb;
$t = $wpdb->prefix . "woocommerce_api_keys";
if ($wpdb->get_var("SELECT COUNT(*) FROM $t WHERE description = \"ERP dev\"")) { echo "\nREST key already created earlier. To get a new one: WooCommerce > Settings > Advanced > REST API.\n"; return; }
$ck = "ck_" . wc_rand_hash(); $cs = "cs_" . wc_rand_hash();
$wpdb->insert($t, ["user_id" => 1, "description" => "ERP dev", "permissions" => "read_write", "consumer_key" => wc_api_hash($ck), "consumer_secret" => $cs, "truncated_key" => substr($ck, -7)]);
echo "\n=== Dev shop ready ===\nIn the ERP, Shop address: https://woo\nConsumer key:    $ck\nConsumer secret: $cs\nWordPress admin: https://localhost:" . getenv("WOO_PORT") . "/wp-admin (admin / admin)\n";'
