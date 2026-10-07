// The sanitizer lives in @chatcenter/shared (auth's onboarding chat uses it
// too). Imported by its file, not the barrel, so a test that mocks the whole
// barrel still gets the real function.
export { withoutWideDashes } from "@chatcenter/shared/src/lib/wide-dash";
