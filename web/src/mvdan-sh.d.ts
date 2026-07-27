declare module 'mvdan-sh' {
  export type ShFile = unknown;
  export type ShOption = unknown;

  export interface Parser {
    Parse(src: string, name: string): ShFile;
  }
  export interface Printer {
    Print(file: ShFile): string;
  }
  export interface Syntax {
    NewParser(...opts: ShOption[]): Parser;
    NewPrinter(...opts: ShOption[]): Printer;
    Indent(n: number): ShOption;
    KeepComments(on: boolean): ShOption;
    BinaryNextLine(on: boolean): ShOption;
  }
  export const syntax: Syntax;
  const _default: { syntax: Syntax };
  export default _default;
}
