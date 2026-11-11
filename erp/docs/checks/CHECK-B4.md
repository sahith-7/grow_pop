# Checking that B4 works

> **GroPop:** these click-throughs were written per build stage. GroPop already contains every stage, so skip the install, copy and commit steps (they point to INSTALL files that no longer exist), then work through the rest. Use the store you created in INSTALL-GROPOP section 4.

Work through the steps in order. Each step says what you should see. The first time something looks different, stop and send me what the step's **If not** line asks for. Don't carry on past it.

Run the commands in a terminal at your `erp/` folder. In PowerShell, run each line on its own.

## A. Install

**1. Install B4** with [INSTALL-B4.md](INSTALL-B4.md) steps 1–6 (restore point, copy the zip, `.env` settings, type-check).

## B. Automatic checks

**2. Start the app with a local test shop.**
```
docker compose down
docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.woo.yml up --build -d
docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.woo.yml logs migrate woo-setup
```
The first start downloads WordPress and WooCommerce, so give it a few minutes.
You should see: `applied 0300_woocommerce.sql`, then `=== Dev shop ready ===` with a **Consumer key** and **Consumer secret**. Keep that window open; you need both in step 5.
If not: send me the output of the last command. If `api` keeps restarting with "WOO_DEV_ALLOW_PRIVATE must not be set in production", set `NODE_ENV=development` in `.env` (local only) and run the `up` line again.

**3. Tests.**
```
npm test
```
You should see: every test file marked ✓, including 2 new `b4-*` test files (41 tests).
If not: send me the names of the failing tests and their error text.

## C. Click through with the local shop

Open the shop admin at https://localhost:8443/wp-admin (user `admin`, password `admin`). Your browser warns about the certificate; that's expected for this test shop, so continue anyway.

**4. Set up the shop.** In WordPress: Products → Add New.
- Product 1: name anything, **SKU = one of your real ERP SKUs** (a simple product, not one with sizes), Regular price `1`, Inventory → Track stock, quantity `99`. Publish.
- Product 2: name "Shop only", SKU `SHOP-ONLY-1`, price `50`. Publish.

**5. Connect.** In the ERP (http://localhost:3000, as the owner) click **WooCommerce** in the sidebar. Shop address `https://woo` (that's the shop's name inside Docker), paste the key, and type a wrong secret, e.g. `cs_` followed by 40 zeros. Press **Test key**.
You should see: a red message starting "WooCommerce refused the key".
Paste the real secret and press **Test key** again. You should see: "Found WooCommerce 11.1.2, prices in INR, weights in kg. The key can read and write." Press **Connect**.
You should see: the Shop panel (key shown as `ck_…` plus 4 characters, "Last good contact just now") and "Products in both systems".
If not: send me the red message and the output of `docker compose logs api --tail 50`.

**6. Review the match.** Wait a few seconds for the counts.
You should see: **Matched by SKU 1** with the shop price `₹1.00` and shop stock `99` highlighted, and **Only in the shop 1** (SHOP-ONLY-1). In WordPress, Product 1 still costs 1: nothing in the shop has changed.
Press **Confirm and sync** and accept. Within a few seconds, refresh Product 1 in WordPress: its price is your ERP price, and its stock is your free stock at Shop floor.

**7. Sell another product online.** Open any other active ERP product → **Online shop** panel → **Sell online**.
You should see: the badge changes to **In the shop** by itself. In WordPress → Products it's there with price, stock, category and its first images.
If it says **Sync failed**: send me the text under the badge.

**8. Stock flows to the shop.** In the ERP, Stock → Adjust stock → add 1 of Product 1 at Shop floor → Post. Refresh Product 1 in WordPress.
You should see: its stock went up by 1 within a few seconds.

**9. An order holds stock.** In WordPress: WooCommerce → Orders → **Add order** → **Add item(s)** → **Add product(s)** → Product 1, quantity 2 → **Add**. Set Status to **Processing** → **Create**.
In the ERP click **Online orders**.
You should see: the order at the top, **Ready to pick**. Open it: both units say **Held** at Shop floor. On the Stock page, Product 1's *available* is 2 lower and *on hand* is unchanged.

**10. An unknown SKU.** Create another order the same way with **Shop only** in it, status Processing.
You should see: Online orders → **Needs attention (1)**. Open it: "Some items are not in the ERP." Press **Match to a product**, scan or search Product 1, pick it. The order turns **Ready to pick**.

**11. Completing takes the stock out once.** In WordPress, open the order from step 9 → Status **Completed** → **Update**. Then change something harmless (add an order note) and **Update** again.
You should see: in the ERP the order is **Completed**. Stock → History shows exactly one **Dispatched** row of −2 for it, by "WooCommerce". On hand is 2 lower; available didn't change again.

**12. Cancelling gives the stock back.** In WordPress set the order from step 10 to **Cancelled**.
You should see: in the ERP it's **Cancelled**, its lines say **Released**, and Product 1's available is back up.

**13. Not enough stock.** Create an order for more of Product 1 than its available stock, status Processing.
You should see: **Short of stock**, with "needs N, M available". Add stock with an adjustment, open the order and press **Try to hold stock again**: it turns **Ready to pick**.

**14. The check-up repairs things.** In WordPress: WooCommerce → Settings → Advanced → Webhooks. You see five **GroPop · …** webhooks, all Active. Open one, set Status to **Disabled**, Save. Also change Product 1's stock in WordPress to `500`.
In the ERP, WooCommerce → **Check now**, wait 10 seconds, refresh WordPress.
You should see: the webhook is Active again and Product 1's stock is back to the ERP's number.

**15. Secrets stay hidden.**
```
docker compose logs api | Select-String "woocommerce/"
```
(on Mac or Linux: `docker compose logs api | grep "woocommerce/"`)
You should see: every webhook address ends in `[redacted]`. No line contains `ck_` or `cs_`.

**16. Roles.** Sign in as a cashier: **Online orders** is in the menu (view only), **WooCommerce** is not. As a manager: WooCommerce is there, without **Replace key** and **Disconnect**.

**17. Stop selling online.** On the product from step 7 press **Stop selling online**.
You should see: in WordPress that product is now a **Draft** (not deleted).

**18. Disconnect.** WooCommerce → **Disconnect** → accept.
You should see: the Connect form again. In WordPress → Webhooks, the five GroPop webhooks are gone. Online orders still lists every order.

To stop the test shop: `docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.woo.yml down` (add `-v` only if you also want to wipe your ERP data and the shop).

## D. Commit and push

**19.** [INSTALL-B4.md](INSTALL-B4.md) step 10. All 3 GitHub Actions jobs green.

## E. On staging with a real shop (end of B4)

This needs a public https address for the ERP, so it waits until staging is up.

- Use a **copy** of the live shop (a WooCommerce staging site), never the live shop. Two ERPs connected to one shop both push stock and fight over it.
- In staging `.env`: its own `WOO_ENC_KEY`, `WOO_WEBHOOK_BASE_URL=https://<staging address>/api`, `NODE_ENV=production`, and no `WOO_DEV_*` lines.

**20. Webhooks reach the ERP through your web app.** Connect, then in WooCommerce place a test order (Cash on delivery is fine).
You should see: it in Online orders within seconds. In WooCommerce → Status → Logs, the `webhooks-delivery` log shows response code 200.
If not: send me the response code from that log. **401** means something between the internet and the API changes the request body; **301/302/307 or 404** means the web app is answering `/api/v1/webhooks/...` itself instead of passing it on. Either is fixed by routing that one path straight to the API, and I'll give you the exact lines for your setup.

**21. Product images reach the shop.** Sell a product with an image online.
You should see: the image in WooCommerce. If the product page in the ERP says "image(s) could not be sent to WooCommerce", WooCommerce can't reach `https://<staging address>/api/v1/webhooks/woocommerce/media/...`; same fix as step 20.
