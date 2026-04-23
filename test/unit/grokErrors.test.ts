import { describe, it, expect } from "vitest";

/**
 * Unit tests for Grok error classifiers.
 * Import the functions directly from the source module.
 */
import {
    isGrokPageClosedError,
    isGrokCdpDeadError,
    isGrokUnauthenticated,
} from "../../src/server/providers/grok/errors";

describe("isGrokPageClosedError", () => {
    const shouldMatch = [
        "Target page, context or browser has been closed",
        "Target closed",
        "page.evaluate: Target page has been closed",
        "page.evaluate: Protocol error (Runtime.callFunctionOn): Target closed.",
        "page.evaluate: Connection closed",
        "page has been closed",
        "Request context disposed",
        "Protocol error (Runtime.callFunctionOn): Target closed",
        // ⬇ NEW patterns added for Grok navigation resilience
        "page.evaluate: Execution context was destroyed, most likely because of a navigation.",
        "Execution context was destroyed",
        "page.goto: net::ERR_ABORTED at https://grok.com/imagine",
        "net::ERR_ABORTED",
    ];

    for (const msg of shouldMatch) {
        it(`should match: "${msg.slice(0, 60)}…"`, () => {
            expect(isGrokPageClosedError(new Error(msg))).toBe(true);
        });
    }

    const shouldNotMatch = [
        "Grok upload fail 401",
        "timeout sau 30s",
        "Grok session: Chrome Grok chưa login",
        "random unrelated error",
    ];

    for (const msg of shouldNotMatch) {
        it(`should NOT match: "${msg.slice(0, 60)}…"`, () => {
            expect(isGrokPageClosedError(new Error(msg))).toBe(false);
        });
    }
});

describe("isGrokCdpDeadError", () => {
    it("should NOT match Execution context destroyed (page-level, not CDP)", () => {
        expect(
            isGrokCdpDeadError(
                new Error("Execution context was destroyed, most likely because of a navigation."),
            ),
        ).toBe(false);
    });

    it("should NOT match net::ERR_ABORTED (page-level, not CDP)", () => {
        expect(isGrokCdpDeadError(new Error("net::ERR_ABORTED"))).toBe(false);
    });

    it("should match Target closed", () => {
        expect(isGrokCdpDeadError(new Error("Target closed"))).toBe(true);
    });

    it("should match browser has been closed", () => {
        expect(isGrokCdpDeadError(new Error("browser has been closed"))).toBe(true);
    });

    it("should match ECONNREFUSED", () => {
        expect(isGrokCdpDeadError(new Error("connect ECONNREFUSED 127.0.0.1:9223"))).toBe(true);
    });
});

describe("isGrokUnauthenticated", () => {
    it("should match 401", () => {
        expect(isGrokUnauthenticated(new Error("Grok API returned 401"))).toBe(true);
    });

    it("should match 403", () => {
        expect(isGrokUnauthenticated(new Error("403 Forbidden"))).toBe(true);
    });

    it("should NOT match page closed errors", () => {
        expect(isGrokUnauthenticated(new Error("Execution context was destroyed"))).toBe(false);
    });
});
