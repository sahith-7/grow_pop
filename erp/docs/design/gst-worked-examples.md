# GST worked examples (for the store's CA)

How the ERP works out GST on counter bills, web-order invoices and credit notes. Every figure below was produced by the code that ships in B5 (`apps/api/src/lib/gst.ts`) and is covered by the API tests. Please confirm the method, or tell us what to change, before the first live bill.

All amounts are in rupees. The ERP calculates in whole paise and rounds half up (0.005 → 0.01).

## 1. Settings the CA should confirm

| Setting (Billing & GST) | What it changes |
|---|---|
| GST registration: regular, composition, or not registered | Regular: Tax Invoice with CGST/SGST or IGST. Composition: Bill of Supply, no tax shown. Not registered: Bill. |
| Shelf prices include GST | Yes for most shops: the shelf price is what the customer pays, and tax is taken out of it. |
| Round counter bills to the nearest rupee | Counter bills only. Web invoices are never rounded, so they match what the customer paid online. |

The seller's legal name, GSTIN and address come from Settings and are copied onto each document when it is issued. The state is the first two digits of the GSTIN.

## 2. Taking tax out of a price that includes GST (same state)

Method: for a line amount *G* (after discounts) at rate *R*%:

- CGST = SGST = round( G × R ÷ (2 × (100 + R)) )
- Taxable value = G − CGST − SGST

So CGST always equals SGST and the line adds back exactly to the price on the shelf. The taxable value takes any rounding, which means it can be 1 paisa away from G ÷ (1 + R/100) rounded on its own. Example 2b shows the case.

| # | Line | Rate | Taxable | CGST | SGST | Line total |
|---|---|---|---|---|---|---|
| 2a | 1 × ₹1,180.00 | 18% | 1,000.00 | 90.00 | 90.00 | 1,180.00 |
| 2b | 1 × ₹999.00 | 40% | 713.58 | 142.71 | 142.71 | 999.00 |
| 2c | 3 × ₹33.33 = ₹99.99 | 5% | 95.23 | 2.38 | 2.38 | 99.99 |

In 2b, 999 ÷ 1.40 = 713.571, which would round to 713.57, with total tax 285.43. That cannot be split into two equal halves. The ERP keeps the halves equal (142.71 + 142.71) and puts the odd paisa into taxable value (713.58). **Question for the CA:** is this acceptable, or do you prefer taxable 713.57 with CGST 142.72 and SGST 142.71?

## 3. Prices that exclude GST

If "Shelf prices include GST" is off, tax is added on top: CGST = SGST = round(G × R ÷ 200).

| # | Line | Rate | Taxable | CGST | SGST | Line total |
|---|---|---|---|---|---|---|
| 3a | 1 × ₹1,000.00 | 18% | 1,000.00 | 90.00 | 90.00 | 1,180.00 |

## 4. Discounts

The discount comes off before tax is worked out, so tax is on the price actually charged. A line discount applies first, then a whole-bill discount on what is left.

| # | Line | Discount | Charged | Taxable | CGST | SGST |
|---|---|---|---|---|---|---|
| 4a | 1 × ₹1,180.00 at 18% | 12% = 141.60 | 1,038.40 | 880.00 | 79.20 | 79.20 |

## 5. Rounding the bill (counter only)

The bill total is rounded to the nearest rupee, and the difference is printed as a "Round off" line. It is not taxed.

| # | Bill | Before rounding | Round off | Total |
|---|---|---|---|---|
| 5a | 2c above | 99.99 | +0.01 | 100.00 |
| 5b | 4a + 2 × ₹33.33 at 5% | 1,105.06 | −0.06 | 1,105.00 |

## 6. Web orders delivered to another state (IGST)

The place of supply for a web order is the delivery state. If it is not the shop's state, IGST = round(G × R ÷ (100 + R)). The ERP takes the amounts the customer paid in WooCommerce as including GST. Shipping and other charges on the order become one "Shipping and handling" line at the highest GST rate among the items.

Example: a shop in Maharashtra (27) sells to Karnataka (29). The order is 2 × ₹1,180 plus ₹118 shipping, ₹2,478 in total.

| Line | Rate | Taxable | IGST | Total |
|---|---|---|---|---|
| Kurta × 2 | 18% | 2,000.00 | 360.00 | 2,360.00 |
| Shipping and handling | 18% | 100.00 | 18.00 | 118.00 |
| **Invoice** | | **2,100.00** | **378.00** | **2,478.00** |

A counter sale is always in the shop's own state (CGST + SGST), even when the customer lives elsewhere. **Question for the CA:** please confirm the "highest rate" rule for shipping, or say which rate you want.

## 7. Credit notes for returns

A return is always against a line of the original invoice. The credit is that line's taxable value and tax in proportion to the quantity returned. The return that brings a line to fully returned takes exactly what is left of it. The credit note that completes an invoice takes the invoice total minus the earlier credit notes, so the credits add up to the invoice to the paisa, round-off included.

Using 2c (3 × ₹33.33, rounded to a ₹100.00 bill) and returning one item at a time:

| Credit note | Taxable | CGST | SGST | Credit (rounded) |
|---|---|---|---|---|
| 1st item | 31.74 | 0.79 | 0.79 | 33.00 |
| 2nd item | 31.74 | 0.79 | 0.79 | 33.00 |
| 3rd item (the remainder) | 31.75 | 0.80 | 0.80 | 34.00 |
| **Total** | **95.23** | **2.38** | **2.38** | **100.00** |

No GST credit note is issued after 30 November following the end of the invoice's financial year (s.34(2)). The ERP refuses the return and tells the user to ask their tax adviser.

## 8. Numbering and the document title

- Each financial year has its own series per document type: `INV/26-27/1`, `INV/26-27/2`, … and `CN/26-27/1`, … The number is at most 16 characters. Numbers never skip and never repeat, because a sale that fails uses no number.
- The title follows the registration: **Tax Invoice**. If taxable and 0% items are mixed, it is **Invoice-cum-Bill of Supply**. If all items are 0%, it is a **Bill of Supply**. A composition seller always issues a **Bill of Supply**, and an unregistered seller issues a **Bill**.
- A customer with a GSTIN makes it a B2B invoice, and every item then needs an HSN code. A B2C bill of ₹50,000 or more needs the customer's name, address and state (Rule 46).
- Invoices are never edited or deleted. A mistake is undone with a credit note: a return, or a void, which credits everything not yet returned.

## 9. Not in this version

E-invoicing (IRN/QR) and e-way bills are not supported (e-invoicing applies above ₹5 crore turnover). Cess is shown as 0. Reverse charge is always "No". There are no GSTR-1 exports yet; the invoice list can be filtered by date for now.
