import markUrl from "./assets/tabloom-mark.svg";

export type TabloomMarkProps = {
  className?: string;
  title?: string;
};

export function TabloomMark({ className, title }: TabloomMarkProps) {
  return (
    // The source is a bundled local asset shared by hosted and extension surfaces.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      className={className}
      src={markUrl}
    />
  );
}
