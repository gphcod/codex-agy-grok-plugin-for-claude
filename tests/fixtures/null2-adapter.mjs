// A second test-only provider id over the same fake child (S2.8), so cross-provider paths through the
// entry (a request id bound to one provider, `reply --last` after another provider's job) are tested
// with two providers. Loaded only when COUNCIL_TEST_NULL_ADAPTER=1.
import base from "./null-adapter.mjs";

const adapter = Object.create(Object.getPrototypeOf(base), Object.getOwnPropertyDescriptors(base));
adapter.id = "null2";
adapter.binEnv = "COUNCIL_NULL2_BIN";
export default adapter;
