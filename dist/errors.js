export class FactoryCoreError extends Error {
    code;
    detail;
    constructor(code, message, detail) {
        super(message);
        this.name = "FactoryCoreError";
        this.code = code;
        this.detail = detail;
    }
}
