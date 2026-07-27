import { useEffect, useRef } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  Clock3,
  ShieldCheck,
} from "lucide-react";
import { useI18n } from "../../../i18n";
import { Link } from "../../../platform/router";
import { BLOG_PATH } from "../../../platform/blog-route";
import {
  BLOG_UI_COPY,
  ENGINEERING_NOTES,
  findEngineeringNote,
  localize,
  type BlogLocale,
  type EngineeringNote,
} from "./blog-content";

export function BlogView({
  slug,
  backHref,
}: {
  slug?: string;
  backHref?: string;
}) {
  const { locale } = useI18n();
  const blogLocale: BlogLocale = locale;
  const copy = BLOG_UI_COPY[blogLocale];
  const note = findEngineeringNote(slug);
  const scrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [slug]);

  return (
    <div data-testid="blog-view" className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-surface)] text-[#2F312C] dark:bg-[#1A1A1A] dark:text-[#E3E4DE]">
      <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-[#E5E8E0] px-4 dark:border-[#30322D] md:px-5">
        {backHref && (
          <Link
            to={backHref}
            data-testid="blog-exit"
            aria-label={locale === "zh" ? "返回应用" : "Back to the app"}
            className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-md text-[#74776E] transition-colors hover:bg-black/[0.05] hover:text-[#33352F] dark:text-[#999C94] dark:hover:bg-white/[0.06] dark:hover:text-[#E5E6E0]"
          >
            <ArrowLeft className="size-[16px]" strokeWidth={1.5} />
          </Link>
        )}
        <BookOpenText className="size-[16px] shrink-0 text-[#676B62] dark:text-[#A2A59D]" strokeWidth={1.55} />
        <span className="text-[13.5px] font-semibold">{copy.title}</span>
        <span className="border border-[#D9D7C9] bg-[#F4F1E7] px-1.5 py-[2px] text-[9.5px] font-semibold uppercase tracking-[0.12em] text-[#7B735F] dark:border-[#454238] dark:bg-[#27251F] dark:text-[#B7AD94]">
          {copy.badge}
        </span>
        <span className="ml-auto hidden text-[10.5px] text-[#8A8D84] dark:text-[#7E8179] sm:block">{copy.provenance}</span>
      </header>

      <main ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto hide-scrollbar">
        {slug ? (
          note ? <NoteDetail note={note} locale={blogLocale} copy={copy} /> : <MissingNote copy={copy} />
        ) : (
          <NotesIndex locale={blogLocale} copy={copy} />
        )}
      </main>
    </div>
  );
}

function NotesIndex({ locale, copy }: { locale: BlogLocale; copy: (typeof BLOG_UI_COPY)[BlogLocale] }) {
  return (
    <div className="mx-auto w-full max-w-[1120px] px-5 pb-16 pt-10 sm:px-8 sm:pt-14 lg:px-12 lg:pt-16">
      <section className="grid gap-10 border-b border-[#DDE1D8] pb-12 dark:border-[#30322D] lg:grid-cols-[minmax(0,1fr)_300px] lg:items-end lg:gap-16 lg:pb-16">
        <div>
          <p className="mb-5 text-[10.5px] font-semibold uppercase tracking-[0.2em] text-[#797D73] dark:text-[#92958C]">{copy.eyebrow}</p>
          <h1 className="max-w-[760px] font-reader text-[clamp(2.35rem,5.7vw,4.85rem)] font-medium leading-[0.98] tracking-[-0.045em] text-[#22241F] dark:text-[#F0F1EB]">
            {copy.headline}
          </h1>
          <p className="mt-7 max-w-[680px] font-reader text-[15px] leading-7 text-[#61655C] dark:text-[#A6A9A1] sm:text-[16px]">
            {copy.intro}
          </p>
        </div>

        <aside className="border-l-2 border-[#B9A36D] pl-4 dark:border-[#8E7B50]">
          <div className="mb-2 flex items-center gap-2 text-[#5E6259] dark:text-[#B4B7AF]">
            <ShieldCheck className="size-[15px]" strokeWidth={1.7} />
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em]">{copy.sourceTitle}</h2>
          </div>
          <p className="text-[12px] leading-5 text-[#777B72] dark:text-[#8F938A]">{copy.sourceBody}</p>
        </aside>
      </section>

      <section className="grid gap-8 pt-10 lg:grid-cols-[190px_minmax(0,1fr)] lg:gap-12 lg:pt-14">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#5E6259] dark:text-[#B0B3AB]">{copy.collection}</h2>
          <p className="mt-3 text-[11.5px] leading-5 text-[#878A82] dark:text-[#777B73]">{copy.collectionBody}</p>
          <p className="mt-5 font-mono text-[10.5px] text-[#A0A39B] dark:text-[#686B64]">{String(ENGINEERING_NOTES.length).padStart(2, "0")} / FIELD NOTES</p>
        </div>

        <div data-testid="blog-note-list" className="border-b border-[#DDE1D8] dark:border-[#30322D]">
          {ENGINEERING_NOTES.map((note) => (
            <Link
              key={note.slug}
              to={`${BLOG_PATH}/${note.slug}`}
              data-testid={`blog-note-${note.slug}`}
              className="group grid grid-cols-[38px_minmax(0,1fr)_18px] gap-3 border-t border-[#DDE1D8] py-6 text-left transition-colors hover:bg-black/[0.018] dark:border-[#30322D] dark:hover:bg-white/[0.025] sm:grid-cols-[52px_minmax(0,1fr)_28px] sm:gap-5 sm:py-7"
            >
              <span className="pt-1 font-mono text-[10.5px] text-[#9A9D95] dark:text-[#6E716A]">{note.sequence}</span>
              <article className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#7B725C] dark:text-[#A99B78]">{localize(locale, note.category)}</span>
                  <span className="inline-flex items-center gap-1 text-[10px] text-[#A0A39A] dark:text-[#6F726B]">
                    <Clock3 className="size-3" strokeWidth={1.6} />
                    {note.readingMinutes} {copy.minutes}
                  </span>
                </div>
                <h3 className="font-reader text-[21px] font-semibold leading-[1.18] tracking-[-0.025em] text-[#292B26] dark:text-[#E7E8E2] sm:text-[25px]">
                  {localize(locale, note.title)}
                </h3>
                <p className="mt-3 max-w-[690px] font-reader text-[13.5px] leading-6 text-[#70746B] dark:text-[#94978F] sm:text-[14px]">
                  {localize(locale, note.summary)}
                </p>
                <p className="mt-3 text-[11.5px] leading-5 text-[#5F635A] dark:text-[#B0B3AB]">
                  <span className="mr-2 font-semibold text-[#383B35] dark:text-[#D8DAD4]">{copy.result}</span>
                  {localize(locale, note.outcome)}
                </p>
              </article>
              <ArrowRight className="mt-1 size-[16px] text-[#9B9E96] transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-[#3E413A] dark:text-[#666A62] dark:group-hover:text-[#C5C8C0]" strokeWidth={1.5} />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function NoteDetail({
  note,
  locale,
  copy,
}: {
  note: EngineeringNote;
  locale: BlogLocale;
  copy: (typeof BLOG_UI_COPY)[BlogLocale];
}) {
  const index = ENGINEERING_NOTES.findIndex((candidate) => candidate.slug === note.slug);
  const next = ENGINEERING_NOTES[(index + 1) % ENGINEERING_NOTES.length];

  return (
    <article data-testid="blog-note-detail" className="mx-auto w-full max-w-[1040px] px-5 pb-20 pt-7 sm:px-8 sm:pt-10 lg:px-12">
      <Link
        to={BLOG_PATH}
        data-testid="blog-back"
        className="inline-flex min-h-9 items-center gap-2 text-[11.5px] font-medium text-[#74786F] transition-colors hover:text-[#30332D] dark:text-[#8F928A] dark:hover:text-[#E0E2DB]"
      >
        <ArrowLeft className="size-[14px]" strokeWidth={1.7} />
        {copy.back}
      </Link>

      <header className="mt-8 max-w-[830px] sm:mt-12">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <span className="font-mono text-[10px] text-[#999D94] dark:text-[#6C7068]">CASE {note.sequence}</span>
          <span className="h-px w-7 bg-[#CFD3CA] dark:bg-[#3B3E38]" aria-hidden />
          <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#7B725C] dark:text-[#AA9B77]">{localize(locale, note.category)}</span>
          <span className="inline-flex items-center gap-1 text-[10px] text-[#9A9D95] dark:text-[#70736C]">
            <Clock3 className="size-3" strokeWidth={1.6} />
            {note.readingMinutes} {copy.minutes}
          </span>
        </div>
        <h1 className="font-reader text-[clamp(2.25rem,5vw,4.5rem)] font-medium leading-[1.01] tracking-[-0.045em] text-[#22241F] dark:text-[#F0F1EB]">
          {localize(locale, note.title)}
        </h1>
        <p className="mt-7 max-w-[760px] font-reader text-[16px] leading-7 text-[#656960] dark:text-[#A6A9A1] sm:text-[18px] sm:leading-8">
          {localize(locale, note.summary)}
        </p>
      </header>

      <dl className="mt-10 grid border-y border-[#DDE1D8] dark:border-[#30322D] sm:mt-14 sm:grid-cols-3">
        <Fact label={copy.signal} value={localize(locale, note.signal)} />
        <Fact label={copy.boundary} value={localize(locale, note.boundary)} bordered />
        <Fact label={copy.outcome} value={localize(locale, note.outcome)} bordered />
      </dl>

      <div className="mt-12 grid gap-10 lg:grid-cols-[150px_minmax(0,680px)] lg:justify-between lg:gap-16 lg:mt-16">
        <nav aria-label={copy.investigation} className="hidden lg:block">
          <div className="sticky top-8 space-y-3 border-l border-[#D7DBD2] pl-3 text-[10px] font-semibold uppercase tracking-[0.13em] text-[#989B93] dark:border-[#343731] dark:text-[#6F726B]">
            <a href="#investigation" className="block hover:text-[#494C45] dark:hover:text-[#C5C7C0]">{copy.investigation}</a>
            <a href="#changes" className="block hover:text-[#494C45] dark:hover:text-[#C5C7C0]">{copy.changes}</a>
            <a href="#principles" className="block hover:text-[#494C45] dark:hover:text-[#C5C7C0]">{copy.principles}</a>
          </div>
        </nav>

        <div className="min-w-0">
          <section id="investigation" className="scroll-mt-8">
            <SectionLabel>{copy.investigation}</SectionLabel>
            <ol className="mt-7 border-t border-[#DDE1D8] dark:border-[#30322D]">
              {note.investigation.map((item, itemIndex) => (
                <li key={itemIndex} className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 border-b border-[#DDE1D8] py-6 dark:border-[#30322D] sm:grid-cols-[42px_minmax(0,1fr)] sm:gap-5 sm:py-7">
                  <span className="pt-1 font-mono text-[10px] text-[#A0A39B] dark:text-[#686C65]">{String(itemIndex + 1).padStart(2, "0")}</span>
                  <div>
                    <h2 className="font-reader text-[19px] font-semibold tracking-[-0.015em] text-[#30322D] dark:text-[#E2E4DD] sm:text-[21px]">{localize(locale, item.title)}</h2>
                    <p className="mt-3 font-reader text-[14px] leading-7 text-[#696D64] dark:text-[#A1A49C] sm:text-[15px]">{localize(locale, item.body)}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section id="changes" className="scroll-mt-8 pt-14 sm:pt-16">
            <SectionLabel>{copy.changes}</SectionLabel>
            <ul className="mt-7 border-t border-[#DDE1D8] dark:border-[#30322D]">
              {note.changes.map((change, changeIndex) => (
                <li key={changeIndex} className="grid grid-cols-[14px_minmax(0,1fr)] gap-3 border-b border-[#DDE1D8] py-4 dark:border-[#30322D]">
                  <span className="mt-[9px] size-1 bg-[#A88F56] dark:bg-[#9B824E]" aria-hidden />
                  <span className="font-reader text-[14px] leading-7 text-[#5E6259] dark:text-[#A8ABA3] sm:text-[15px]">{localize(locale, change)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section id="principles" className="scroll-mt-8 pt-14 sm:pt-16">
            <SectionLabel>{copy.principles}</SectionLabel>
            <div className="mt-7 space-y-5">
              {note.principles.map((principle, principleIndex) => (
                <blockquote key={principleIndex} className="border-l-2 border-[#B9A36D] py-1 pl-5 font-reader text-[20px] font-medium leading-8 tracking-[-0.02em] text-[#343731] dark:border-[#8E7B50] dark:text-[#D8DAD4] sm:text-[23px]">
                  {localize(locale, principle)}
                </blockquote>
              ))}
            </div>
          </section>

          {note.references && note.references.length > 0 && (
            <section id="references" className="scroll-mt-8 pt-14 sm:pt-16">
              <SectionLabel>{copy.references}</SectionLabel>
              <ol className="mt-7 space-y-2.5">
                {note.references.map((reference, referenceIndex) => (
                  <li key={referenceIndex} className="grid grid-cols-[22px_minmax(0,1fr)] gap-2 font-reader text-[13.5px] leading-6 text-[#5E6259] dark:text-[#A8ABA3]">
                    <span className="tabular-nums text-[#9A9D95] dark:text-[#6B6F67]">{referenceIndex + 1}.</span>
                    <span className="min-w-0">
                      {localize(locale, reference.label)}{" "}
                      <a href={reference.url} target="_blank" rel="noreferrer" className="break-all text-[#8A6D3B] underline decoration-[#D8C9A6] underline-offset-2 hover:text-[#6E5426] dark:text-[#C0A76B] dark:decoration-[#5E5233] dark:hover:text-[#D9C289]">
                        {reference.url}
                      </a>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </div>

      <footer className="mt-16 border-t border-[#DDE1D8] pt-7 dark:border-[#30322D] sm:mt-20">
        <p className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-[#9A9D95] dark:text-[#6B6F67]">{copy.next}</p>
        <Link to={`${BLOG_PATH}/${next.slug}`} className="group mt-3 flex max-w-[720px] items-start justify-between gap-5 py-2">
          <span className="font-reader text-[22px] font-semibold leading-7 tracking-[-0.02em] text-[#333630] group-hover:text-[#11130F] dark:text-[#DADCD6] dark:group-hover:text-white sm:text-[26px]">
            {localize(locale, next.title)}
          </span>
          <ArrowRight className="mt-1 size-[18px] shrink-0 text-[#999C94] transition-transform duration-150 group-hover:translate-x-0.5 dark:text-[#6B6F67]" strokeWidth={1.5} />
        </Link>
      </footer>
    </article>
  );
}

function Fact({ label, value, bordered = false }: { label: string; value: string; bordered?: boolean }) {
  return (
    <div className={`${bordered ? "border-t border-[#DDE1D8] dark:border-[#30322D] sm:border-l sm:border-t-0" : ""} px-0 py-5 sm:px-5 sm:py-6 first:pl-0 last:pr-0`}>
      <dt className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-[#979A92] dark:text-[#6F726B]">{label}</dt>
      <dd className="mt-2 font-reader text-[12.5px] leading-5 text-[#555950] dark:text-[#AEB1A9]">{value}</dd>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.17em] text-[#64685F] dark:text-[#A4A79F]">{children}</h2>;
}

function MissingNote({ copy }: { copy: (typeof BLOG_UI_COPY)[BlogLocale] }) {
  return (
    <div data-testid="blog-note-missing" className="mx-auto flex min-h-[70vh] w-full max-w-[720px] flex-col items-start justify-center px-6 py-16">
      <span className="font-mono text-[10px] text-[#9A9D95] dark:text-[#6C7068]">404 / FIELD NOTE</span>
      <h1 className="mt-5 font-reader text-[32px] font-semibold leading-tight tracking-[-0.035em] text-[#292B26] dark:text-[#E7E8E2] sm:text-[42px]">{copy.missingTitle}</h1>
      <p className="mt-4 text-[13.5px] leading-6 text-[#72766D] dark:text-[#92958D]">{copy.missingBody}</p>
      <Link to={BLOG_PATH} className="mt-7 inline-flex min-h-9 items-center gap-2 text-[12px] font-medium text-[#555950] hover:text-[#22241F] dark:text-[#B2B5AD] dark:hover:text-white">
        <ArrowLeft className="size-[14px]" strokeWidth={1.7} />
        {copy.back}
      </Link>
    </div>
  );
}
