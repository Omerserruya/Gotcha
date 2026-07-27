# iCount API v3 — outstanding integration questions

Ready to send. Contains no API token, no card token, no customer data, no
tenant identifiers and no raw provider responses.

---

Hello,

We are integrating iCount API v3 for subscription billing. Authentication via
`Authorization: Bearer <API token>` is working, and we have confirmed with your
support team that stored cards are charged with `POST /cc/bill` using
`sum`, `token` and `client_id` / `custom_client_id`, that `POST /cc/transactions`
is used for transaction lookup, and that `POST /doc/cancel` with
`refund_cc: true` performs a full document-linked refund.

We own the subscription lifecycle and monthly renewal ourselves and do **not**
use an iCount standing order (`hk_page = 0`). Our payment page is configured as
`doctype = cc_token`.

Could you please provide **current API v3 request and response examples** for
the following? We are holding live charging disabled until these are confirmed.

## 1. cc_token PayPage launch and callback

1. How is a `cc_token` page opened for a customer — a static URL derived from
   the page ID, or a URL generated through an API call?
2. If it is an API call, which endpoint, and what are the request and response?
3. How do we supply `client_id` for the customer the card should be saved to?
4. How do we supply `custom_client_id`?
5. Can we pass an **opaque reference of our own** (an order/checkout id) that is
   returned to us on the callback? Which field?
6. How are the success, failure and cancellation redirect URLs supplied?
7. How is `ipn_url` supplied?
8. For each of items 3–7: is the value **page configuration** or a
   **per-session parameter**?

## 2. Saved-card token retrieval

9. After the customer completes the `cc_token` page, is the reusable card token
   returned in the IPN?
10. Is it returned in the browser redirect?
11. Or must it be retrieved afterwards from the iCount customer record?
12. Which API operation lists or retrieves the saved cards for a customer?
13. Which safe card metadata is returned with it (brand, last 4, expiry)?
14. How do we verify **server-side** that tokenization actually succeeded? We
    will not treat a browser redirect as proof.
15. If a customer tokenizes a second card, how do we distinguish the new token
    from the previous one?
16. What happens to the ₪1 validation transaction — is it voided automatically,
    or does it settle and need reversing?

## 3. cc/bill — currency

Our prices are set in USD while the account base currency is ILS, so this is
blocking for us.

17. Does `cc/bill` accept an explicit currency parameter? What is the **exact
    field name**?
18. Which values are accepted — ISO codes (`USD`), numeric currency ids, or
    another format?
19. If currency is omitted, which currency is charged?
20. Is the currency derived from the account, the terminal, the customer, the
    token, or the document?
21. Can the **same stored token** be charged in both USD and ILS?
22. Does our acquiring terminal support USD?
23. Does the `cc/bill` response return the currency actually charged?
24. Does `cc/transactions` return the transaction currency?

## 4. cc/bill — per-charge reference and idempotency

Monthly renewal and dunning retry by nature, so we need to guarantee a retry
cannot become a second charge.

25. Does `cc/bill` accept a **merchant-generated unique transaction reference**?
    What is the exact field name?
26. Is it enforced as unique by iCount?
27. Is it returned in the `cc/bill` response?
28. Is it searchable, and returned, by `cc/transactions`?
29. Can it be included on the resulting accounting document?
30. What happens if the **same reference is submitted twice** — is the second
    request rejected, or does it charge again?
31. Is there a provider idempotency header or request field?

If there is no such mechanism, please confirm that explicitly so we can document
the limitation.

## 5. cc/bill — document creation

32. Does `cc/bill` create an accounting document by itself?
33. If so, which document type?
34. Can the document type be selected in the request?
35. Does the response return `doctype`?
36. Does the response return `docnum`?
37. If `cc/bill` does **not** create a document, which `doc/create` call should
    follow, and what is the exact request?
38. How is the card transaction linked to the resulting document?
39. If the card charge succeeds but document creation fails, what is the
    recommended recovery procedure?

## 6. doc/cancel — refunds

40. Does `doc/cancel` with `refund_cc: true` support only a **full** refund?
41. Is a **partial** refund supported at all?
42. If yes, what is the exact partial-refund request contract?
43. What happens if the same cancellation is submitted twice?

Thank you.

---

## Why each block blocks us

| Block | Blocks |
|---|---|
| 1–2 | The entire customer-facing checkout. We will not build a tokenization frontend on a guessed callback contract. |
| 3 | Charging a USD plan price. Currently any non-ILS charge is refused rather than sent with an unspecified currency. |
| 4 | Safe renewal retries. Without a provider-side unique reference we rely solely on our own database uniqueness plus reconciliation. |
| 5–6 | Refunds. `doc/cancel` is document-linked, so a charge with no document reference cannot be refunded. |
