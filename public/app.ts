// Page logic lands in a later PR. For now it only mirrors the input into ?n= so links are shareable.
const form = document.querySelector<HTMLFormElement>("#lookup")!;
const input = document.querySelector<HTMLInputElement>("#q")!;

input.value = new URLSearchParams(location.search).get("n") ?? "";

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = new URL(location.href);
  url.searchParams.set("n", input.value.trim());
  history.replaceState(null, "", url);
});
