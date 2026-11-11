# Checking that B6 works

> **GroPop:** these click-throughs were written per build stage. GroPop already contains every stage, so skip the install, copy and commit steps (they point to INSTALL files that no longer exist), then work through the rest. Use the store you created in INSTALL-GROPOP section 4.

Work through the steps in order. Each step says what you should see. The first time something looks different, stop and send me what the step's **If not** line asks for. Don't carry on past it.

Sections C to E need your test WooCommerce shop connected, as in CHECK-B4. If web orders don't reach the ERP yet, do A, B, F and G now and the rest once B4 works on your machine.

## A. Install

**1. Install B6** with [INSTALL-B6.md](INSTALL-B6.md) steps 1–8.

**2. Tests.**
```
npm test
```
You should see every test file marked ✓, including 4 new `b6-*` test files (27 tests).
If not: send me the names of the failing tests and their error text.

## B. Menus and dashboard

**3. Owner menu.** Sign in as the owner.
You should see **Fulfilment** under Online orders and **Reports** under Suppliers.

**4. Dashboard.** Open **Dashboard**.
You should see tiles for net sales today, low stock, web orders needing attention, ready to pick, being picked, dispatches the shop has not heard about, failed sync jobs and stocktakes to approve, then Recent orders and Best sellers.
If not: send me a screenshot and the lines you added to the dashboard page in INSTALL step 5.

## C. Pick

You need a product with a barcode and at least 5 in stock at the online location (Shop floor unless you changed it).

**5. Two orders.** In your test shop, place two orders that include that product, and pay with "Cash on delivery" so WooCommerce marks them **Processing**. In the ERP, open **Fulfilment**.
You should see both under **Ready to pick**, oldest first. If they aren't there, check **Online orders** (they may be "Short of stock"), or wait for the 15-minute check-up.

**6. Start a pick list.** Tick both orders and press **Pick 2 orders**.
You should see a full-width page called **PK-00001** with each item, the bag (order number) it goes in, and "0 / n" picked.

**7. Wrong item.** In the scan box type `WRONG-1` and press Enter.
You should see the box turn red, a low beep, and "“WRONG-1” is not a product in the ERP". Nothing is counted.

**8. Right item.** Scan the product's barcode (or type its SKU) once.
You should see the box turn green, a short high beep, and "SKU → bag #…" naming the older order. Its line shows 1 picked.

**9. One too many.** Keep scanning that product until every line for it shows ✓, then scan it once more.
You should see red and "All … on this list are already picked. Put this one back."

**10. An item with no barcode.** Press the "0 / n" button on any remaining line, then **All**, then **Save**.
When every line is picked you should see "Everything is picked" and **Go to packing**.

**11. On a phone (optional).** Open the same pick-list address on a phone on your network.
You should see the same screen fitting the phone width with no sideways scrolling.

## D. Pack and dispatch

**12. Pack.** Press **Go to packing**. On the first order press **Pack**, tick each item, press **Packed**. Do the same for the second order.
You should see both move to the **Packed** tab.

**13. Dispatch.** On **Packed**, press **Dispatch** on one order. Courier `Delhivery`, Service `Surface`, Tracking number `TEST123`. Press **Dispatch**.
You should see the order leave the Packed tab.

**14. The order page.** Open that order from **Online orders → Dispatched**.
You should see:
- a **Shipment** panel: Delhivery · Surface · tracking TEST123, dispatched by you;
- a badge that changes from "Sending to shop" to **Shop updated** within a few seconds (reload the page);
- a **GST invoice** panel with a new invoice number;
- in the timeline: On pick list PK-00001, Packed, Dispatched … reserved stock deducted, Invoice … issued.

If the badge says "Shop not updated": send me the text under it.

**15. In WooCommerce.** Open the same order in the shop's admin.
You should see status **Completed**, and an order note "Your order has been dispatched via Delhivery (Surface). Tracking number: TEST123" marked as a note to the customer. The shop also sends the customer two emails (the note and "order complete").
Back in the ERP, after the shop's webhook arrives, the order shows **Completed**.

**16. Stock left once.** Stock page → the product → history.
You should see one **Dispatch** row per order line for this order, and no second row after the order became Completed.

**17. Dispatch without tracking.** Dispatch the second order with courier `Hand delivery` and no tracking number.
You should see it dispatched. In the shop, the note says "Your order has been dispatched via Hand delivery."

## E. When the shop changes an order during picking

**18. Cancelled in the shop.** Place another order, start a pick list for it, scan one item. Then cancel the order in WooCommerce.
You should see, in the ERP: the order **Cancelled**, its stock released, and on the pick-list page a yellow box "Taken off this list: #… put anything already picked back on the shelf". The timeline says the same.

**19. Take an order off picking.** Place another order, start a pick list, open the order page and press **Take off picking**, give a reason.
You should see the order back in **Ready to pick**, still holding its stock.

## F. Reports

**20. Each report.** Open **Reports** and click each tab: Inventory summary, Low stock, Stock movements, Stocktake variance, Purchasing, Sales, Sync health.
You should see a table for each (or "No rows"), a total row where it applies, and on Sales today's counter and website sales: invoiced, credited (returns and voids), net sales and net GST. Nothing is called profit.

**21. CSV.** On Inventory summary press **Download CSV** and open the file in Excel.
You should see one row per item with the same numbers as the screen, and rupee symbols display correctly.

**22. Roles.** Sign in as an **inventory** user.
You should see Reports without the Sales and Sync health tabs, and no Download CSV button. As a **cashier** or **fulfillment** user you should see no Reports menu at all.

## G. Push

**23. CI.** After INSTALL step 9, GitHub → Actions: all 3 jobs green.
If not: send me the failing job's log from the first red line.
