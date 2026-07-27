let reqCounter = 0;
export const nextReq = (): string => 'r' + ++reqCounter;
