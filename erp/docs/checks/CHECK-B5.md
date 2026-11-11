# Checking that B5 works

> **GroPop:** these click-throughs were written per build stage. GroPop already contains every stage, so skip the install, copy and commit steps (they point to INSTALL files that no longer exist), then work through the rest. Use the store you created in INSTALL-GROPOP section 4.

Work through the steps in order. Each step says what you should see. The first time something looks different, stop and send me what the step's **If not** line asks for. Don't carry on past it.

Run the commands in a terminal at your `erp/` folder. Amounts below assume a shop in Maharashtra. If your GSTIN starts with another state code, the state names change and the tax doesn't.

## A. Install

**1. Install B5** with [INSTALL-B5.md](INSTALL-B5.md) steps 1–6.

**2. Tests.**
```
npm test
```
You should see every test file marked ✓, including 5 new `b5-*` files (51 tests).
If not: send me the names of the failing tests and their error text.

## B. Set up billing

**3. The counter refuses to bill before setup.** Sign in as the owner. Click **Counter (POS)** in the sidebar.
You should see "The counter cannot bill yet" with a list. "Choose your GST registration" is on it, plus anything missing from Settings.

**4. Seller details.** Go to **Settings** and fill in the legal business name, address, city, state, postal code and GSTIN. On your own machine you can use the GST department's sample GSTIN `27AAPFU0939F1ZV`. **Never use it on a live store.**

**5. Billing & GST.** Open **Billing & GST**. Check that the "Seller on the invoice" panel shows what you typed. Set GST registration to **Registered (regular GST)**, leave the rest as it is, and press **Save**.
You should see "Saved." and no yellow box.
If a yellow box stays: send me its text.

**6. A product to sell.** Make sure you have an active product with price **₹1,180**, GST rate **18%**, HSN **6211** and at least 5 in stock at Shop floor. Use Stock → Adjust stock if needed.

## C. Counter sale

**7. Scan.** Open **Counter (POS)**. Type the product's SKU (or scan its barcode) and press Enter. Press Enter on the same SKU again.
You should see one line with quantity **2**. Items ₹2,360.00, CGST ₹180.00, SGST ₹180.00, Total **₹2,360.00**.
If not: send me a screenshot.

**8. Discount needs a reason.** Type `12` in Disc %.
You should see a red message, "Give a reason for a discount above 10%", and the pay button disappears. Type a reason, e.g. "Display piece".
You should see Total **₹2,076.80** → rounded to **₹2,077.00**, with Round off ₹0.20.

**9. Pay and give change.** In the cash box type `2100`.
You should see "Give change: ₹23.00". Press **Take ₹2,077.00**.
You should see "Paid · INV/26-27/1" and a receipt. Press **Print receipt** and check the print preview: one narrow column, nothing else from the page.
If the number isn't `INV/26-27/1`: tell me the number shown.

**10. Enter never takes payment.** Press **Next customer**. Scan the SKU once, then press Enter a few more times in the empty scan box.
You should see one line with quantity 1 and no sale made. Press **Clear bill**.

**11. Stock went down.** Stock page → the product.
You should see on hand down by 2 and a **Sale** row in its history, numbered INV/26-27/1.

## D. Invoices, returns and voids

**12. The invoice.** Click **Invoices** → INV/26-27/1.
You should see a Tax Invoice with your legal name, GSTIN, "Place of supply: Maharashtra (27)", HSN 6211, discount, CGST and SGST columns, the amount in words, and **Money: Paid · Cash · change ₹23.00**. Press **Print A4** and check the preview fits one page.

**13. Return one item.** Press **Return items**. Type 1 in Return for the line, keep "Back to stock", give the reason "Wrong size", keep Money back = Cash, and press **Issue credit note for 1 item**.
You should see "Credit Note CN/26-27/1" against INV/26-27/1, total **₹1,038.00** (₹1,038.40 credited, rounded), back by cash. On the Stock page, on hand is up by 1.

**14. Void the rest.** Open INV/26-27/1 again. Press **Void**, give the reason "Test", untick "put back in stock", choose **No refund**, and confirm.
You should see the invoice marked **Voided**, with the original amounts unchanged, and a second credit note CN/26-27/2 of kind void for ₹1,039.00. The Return and Void buttons are gone. Stock didn't change.

**15. Today's takings.** Counter → **Today's takings**.
You should see Cash: in ₹2,077.00, refunded ₹1,038.00, net ₹1,039.00.

**16. Invoices can't be edited, even by the database user.**
```
docker compose exec db psql -U erp_app -d erp -c "UPDATE invoices SET total = 0"
```
You should see `permission denied for table invoices`. (If your database user or name differs, use the one from `DATABASE_URL`.)

## E. Web orders (needs B4's local test shop)

**17. Invoice on completion.** Start the local shop as in CHECK-B4 step 2. In WordPress, create an order for the product with a shipping address in **Karnataka**, set it to **Processing**, and wait until the ERP shows it **Ready to pick**. Then set it to **Completed** in WordPress.
On the ERP order page you should see a **GST invoice** panel with INV/26-27/2. Open it: Place of supply Karnataka (29), **IGST** instead of CGST/SGST, and the total exactly equals the WooCommerce order total (shipping is its own line).
If the panel says "No invoice yet", send me its yellow text.

An address the ERP can't place (a misspelt state, for example) leaves the invoice pending with a state picker on the order page. The tests cover this, because WordPress's own order screen only offers valid Indian states.

## F. Done

Commit and push (INSTALL-B5 step 9), and check that all 3 GitHub jobs are green. Then send me "B5 checked", or the first step that failed.
