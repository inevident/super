import { notFound } from "next/navigation";
import { getListing } from "@/lib/listings";
import ListingDetail from "./ListingDetail";

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const listing = getListing(decodeURIComponent(id));
  if (!listing) notFound();
  return <ListingDetail listing={listing} />;
}
