# Checking that B3 works

> **TRIDENT:** these click-throughs were written per build stage. TRIDENT already contains every stage, so skip the install, copy and commit steps (they point to INSTALL files that no longer exist), then work through the rest. Use the store you created in INSTALL-TRIDENT section 4.

Work through the steps in order. Each step says what you should see. The first time something looks different, stop and send me what the step's **If not** line asks for. Don't carry on past it.

Run the commands in a terminal at your `erp/` folder. In PowerShell, run each line on its own.

## A. Install (skip if you've already copied the B3 zip)

**1. Save B2.**
```
git status
```
You should see: `.env` is **not** in the list.
If not: stop and tell me. Don't commit.
```
git add -A
git commit -m "B2: products, barcodes, CSV import"
```

**2. Copy B3.** Unzip `the stage zip`. Copy everything inside its `erp/` folder into your `erp/` folder, and choose **Replace** when asked.
You should see: Windows replaces 6 files and adds the rest.

## B. Automatic checks

**3. Type-check.**
```
npm run typecheck
```
You should see: it finishes with no lines containing `error TS`.
If not: send me the full output.

**4. Start the app.**
```
docker compose down
docker compose up --build -d
docker compose logs migrate
```
You should see: `applied 0200_inventory.sql` in the log. `docker compose ps` should show `api`, `web` and `worker` running.
If not: send me the output of `docker compose logs migrate api --tail 80`.

**5. Tests.**
```
npm test
```
You should see: every test file marked ✓, including 4 new `b3-*` files (32 tests).
If not: send me the names of the failing tests and their error text.
If it can't reach the database on your machine, skip this step; GitHub runs it in step 17.

## C. Click through (open http://localhost:3000, sign in as the owner)

**6. Stock menu.** Click **Stock** in the sidebar.
You should see: every product, each with 0 on hand. There are also **Stocktakes**, **Purchasing** and **Suppliers** menu items.

**7. Opening stock.** Stock → **Opening stock** → **Download the template**. Replace the example rows with 2 or 3 of your real SKUs and quantities, save as CSV, then upload it.
You should see: "Ready" equal to your row count, and 0 problems. Press **Post N rows**.
You should see: "Posted ADJ-… (Shop floor)". Back on Stock, those items show the quantities you entered.

**8. Write off.** Stock → **Adjust stock**. Pick reason *Damaged — write off*, scan or search one of those items, set the quantity to `1`, then press **Post adjustment**.
You should see: the History page with a green "posted" banner and one row showing the before and after quantities (for example `10 → 9`).
Also try: scan an item into the box, then press Enter in a quantity box. Nothing should be posted until you click the button.

**9. Transfer and reverse.** Stock → **Transfer**, from Shop floor to Back room, one item with quantity 2, then **Post transfer**.
You should see: two rows in History, −2 at Shop floor and +2 at Back room.
Then press **Reverse TRF-…**, type a reason and confirm. You should see: the original rows are still there, marked *reversed*, with two new Reversal rows.

**10. Negative stock.** Adjust stock → reason *Correction* → **Remove stock** → enter a quantity larger than what's on hand → **Post adjustment**.
You should see: it is refused with "Only N of <SKU> available at <location>".

**11. Supplier.** **Suppliers** → **Add supplier** → enter a name and a GSTIN, then save.
You should see: the GSTIN in capitals, and the State column filled in from its first 2 digits.

**12. Purchase order.** **Purchasing** → **New purchase order** → choose the supplier → add 2 items with quantities and unit costs.
You should see: the total update as you type. Press **Create draft**, change a quantity, then press **Save draft**. "Saved" appears. Press **Mark as sent** and confirm. The badge says *Sent*.

**13. Receive goods.** On that order press **Receive goods** → **Fill what was ordered** → lower one item's *Accepted* by 1. Its *Damaged* column shows 1. Press **Post receipt**.
You should see: the receipt page, with 1 damaged. The order now says *Part received*, with 1 still to come on that line. Stock shows the accepted quantity added, and 1 under *Damaged*.

**14. Return to supplier.** On the receipt press **Return damaged to supplier** → **Post return**.
You should see: an SR-… "posted" banner. That item's *Damaged* count is back to 0.

**15. Stocktake.** **Stocktakes** → choose *Shop floor* → **Start counting**. Scan one item twice, then press **Send for approval** → **Approve and post** → **Post**.
You should see: that item's stock becomes exactly 2. Items you didn't scan keep their old quantity.

**16. Permissions and totals.**
- Open http://localhost:3000/api/v1/stock/reconciliation in the same browser. You should see `{"mismatches":[]}`. Anything inside the brackets means stock and history disagree; send it to me.
- **Team** → add a **cashier**, then sign in as them. There is no Stock, Stocktakes or Purchasing in the menu, and opening http://localhost:3000/stock shows a permission error instead of the list.

## D. Push

**17.** Commit and push:
```
git status
git add -A
git commit -m "B3: stock, purchasing, stocktakes"
git push
```
Before running `git add`, check that `.env` is not in the `git status` list.
You should see: on GitHub → Actions, all 3 jobs (`api`, `web`, `audit`) green.
If not: send me the name of the red job and the last 40 lines of its log. If only `audit` is red, send the output of `npm audit --omit=dev` instead. B3 adds no packages, so a red `audit` was red before B3.

## If something breaks badly

Run `git reset --hard` to go back to step 1, then send me the error. Don't run `docker compose down -v`: it deletes your data, and B3 doesn't need it.
