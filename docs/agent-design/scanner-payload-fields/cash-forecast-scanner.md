# Cash Forecast Scanner Payload Fields

`horizon_days` is fixed at 180 for scanner output. The source query now includes receivables and payables due within that horizon. `drivers` groups those dated flows by counterparty and flow type, then emits the largest movers. `runway_projection` walks weekly through the 180 day window and applies dated receivables and payables to the current balance. If there are no dated flows, drivers and runway projection are omitted.
