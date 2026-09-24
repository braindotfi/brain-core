# Revenue Intel Scanner Payload Fields

`concentration` is derived from paid invoice amount by customer in the current 30 day period. `historical_concentration` computes the top customer share by quarter over the last eight quarters from invoice history. `pipeline_coverage` is emitted only when current quarter invoice metadata includes pipeline plan or weighted pipeline values. Missing metadata leaves pipeline coverage undefined.
