<?php
/**
 * Removed from WP Admin: tell GOTCHA (the site shows as removed there and its
 * key stops working), then forget everything this plugin stored.
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

$gotcha_key = get_option( 'gotcha_wc_site_key' );
$gotcha_api = get_option( 'gotcha_wc_api_url' );
if ( $gotcha_key && $gotcha_api ) {
	wp_remote_post(
		untrailingslashit( $gotcha_api ) . '/api/woocommerce-plugin/signal',
		array(
			'timeout'  => 5,
			'blocking' => false,
			'headers'  => array(
				'Authorization' => 'Bearer ' . $gotcha_key,
				'Content-Type'  => 'application/json',
			),
			'body'     => wp_json_encode( array( 'event' => 'uninstalled', 'siteUrl' => home_url() ) ),
		)
	);
}

foreach ( array( 'gotcha_wc_widget_id', 'gotcha_wc_site_key', 'gotcha_wc_api_url', 'gotcha_wc_script_url', 'gotcha_wc_workspace' ) as $gotcha_opt ) {
	delete_option( $gotcha_opt );
}
delete_transient( 'gotcha_wc_connect_nonce' );
wp_clear_scheduled_hook( 'gotcha_wc_heartbeat' );
