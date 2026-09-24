# Treasury Scanner Payload Fields

`allocation_before` is derived from active latest balances in the same currency as the scanned balance, using checking accounts as operating cash and savings accounts as reserve cash. `allocation_after` is emitted only for high balance recommendations when a reserve account exists and the proposed sweep can be projected. `safety_meter` is emitted for USD rows from the scanner thresholds. `estimated_annual_yield_gain` is emitted only when the row supplies both current and recommended yield rates.
