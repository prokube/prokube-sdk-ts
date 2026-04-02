import { describe, expect, it } from "vitest";
import {
	AuthenticationError,
	NotFoundError,
	PoolExhaustedError,
	PoolNotFoundError,
	ProKubeError,
	SandboxError,
	SandboxExecutionError,
	SandboxNotFoundError,
	SandboxTimeoutError,
} from "../src/common/errors.js";

describe("Error hierarchy", () => {
	it("ProKubeError is base error", () => {
		const err = new ProKubeError("test");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(ProKubeError);
		expect(err.message).toBe("test");
	});

	it("AuthenticationError inherits from ProKubeError", () => {
		const err = new AuthenticationError("auth failed", 401);
		expect(err).toBeInstanceOf(ProKubeError);
		expect(err.statusCode).toBe(401);
	});

	it("SandboxError inherits from ProKubeError", () => {
		expect(new SandboxError("sandbox")).toBeInstanceOf(ProKubeError);
	});

	it("NotFoundError inherits from ProKubeError", () => {
		const err = new NotFoundError("not found");
		expect(err).toBeInstanceOf(ProKubeError);
		expect(err.statusCode).toBe(404);
	});

	it("SandboxNotFoundError inherits from SandboxError", () => {
		const err = new SandboxNotFoundError("sandbox not found");
		expect(err).toBeInstanceOf(SandboxError);
		expect(err).toBeInstanceOf(ProKubeError);
		expect(err.statusCode).toBe(404);
	});

	it("SandboxTimeoutError inherits from SandboxError", () => {
		expect(new SandboxTimeoutError("timeout")).toBeInstanceOf(SandboxError);
	});

	it("SandboxExecutionError inherits from SandboxError", () => {
		expect(new SandboxExecutionError("exec")).toBeInstanceOf(SandboxError);
	});

	it("PoolNotFoundError inherits from SandboxError", () => {
		const err = new PoolNotFoundError("pool not found");
		expect(err).toBeInstanceOf(SandboxError);
		expect(err.statusCode).toBe(404);
	});

	it("PoolExhaustedError inherits from SandboxError", () => {
		expect(new PoolExhaustedError("exhausted")).toBeInstanceOf(SandboxError);
	});
});
