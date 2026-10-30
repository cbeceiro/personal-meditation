-- Meditaciones de T-med: cada usuario lee solo las suyas; solo el script de publicación escribe.
create table public.meditaciones (
  user_id uuid not null references auth.users (id) on delete cascade,
  slug text not null,
  titulo text not null,
  descripcion text not null default '',
  texto text not null,
  texto_hash text not null,
  audio_ruta text not null,
  duracion_s integer,
  marcas jsonb, -- segundos en que empiezan el silencio final y el cierre: {"silencio": 300.5, "cierre": 540.5}
  orden integer not null default 0,
  publicado boolean not null default true,
  creado_en timestamptz not null default now(),
  primary key (user_id, slug)
);

alter table public.meditaciones enable row level security;

create policy "cada usuario lee sus meditaciones publicadas"
  on public.meditaciones for select
  to authenticated
  using (user_id = (select auth.uid()) and publicado);

revoke all on public.meditaciones from anon, authenticated;
grant select on public.meditaciones to authenticated;
grant all on public.meditaciones to service_role;

-- Bucket privado para los audios: cada usuario lee solo los de su carpeta (<user_id>/...).
insert into storage.buckets (id, name, public)
values ('meditaciones-audio', 'meditaciones-audio', false)
on conflict (id) do nothing;

create policy "cada usuario lee sus audios de meditaciones"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'meditaciones-audio'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Migración para bases creadas antes de existir la columna marcas:
-- alter table public.meditaciones add column if not exists marcas jsonb;
