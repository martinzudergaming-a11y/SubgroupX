import { DEFAULT_PRODUCT_NAME } from "@shared/brand";

export const PRODUCT_NAME: string = (import.meta.env.VITE_PRODUCT_NAME as string | undefined) ?? DEFAULT_PRODUCT_NAME;

export const REPO_URL = "https://github.com/n-WN/SubgroupX";
