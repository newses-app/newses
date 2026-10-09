-- Schema-only pg_dump of a TTRSS database at schema version 151, the importer's test fixture.
-- It holds TTRSS's table definitions only; tests add synthetic rows (ADR 0009).
--
-- PostgreSQL database dump
--

-- Dumped from database version 12.22
-- Dumped by pg_dump version 12.22

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: substring_for_date(timestamp without time zone, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.substring_for_date(timestamp without time zone, integer, integer) RETURNS text
    LANGUAGE sql
    AS $_$SELECT SUBSTRING(CAST($1 AS text), $2, $3)$_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ttrss_access_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_access_keys (
    id integer NOT NULL,
    access_key character varying(250) NOT NULL,
    feed_id character varying(250) NOT NULL,
    is_cat boolean DEFAULT false NOT NULL,
    owner_uid integer NOT NULL
);


--
-- Name: ttrss_access_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_access_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_access_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_access_keys_id_seq OWNED BY public.ttrss_access_keys.id;


--
-- Name: ttrss_app_passwords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_app_passwords (
    id integer NOT NULL,
    title character varying(250) NOT NULL,
    pwd_hash text NOT NULL,
    service character varying(100) NOT NULL,
    created timestamp without time zone NOT NULL,
    last_used timestamp without time zone,
    owner_uid integer NOT NULL
);


--
-- Name: ttrss_app_passwords_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_app_passwords_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_app_passwords_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_app_passwords_id_seq OWNED BY public.ttrss_app_passwords.id;


--
-- Name: ttrss_archived_feeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_archived_feeds (
    id integer NOT NULL,
    owner_uid integer NOT NULL,
    created timestamp without time zone NOT NULL,
    title character varying(200) NOT NULL,
    feed_url text NOT NULL,
    site_url character varying(250) DEFAULT ''::character varying NOT NULL
);


--
-- Name: ttrss_cat_counters_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_cat_counters_cache (
    feed_id integer NOT NULL,
    owner_uid integer NOT NULL,
    updated timestamp without time zone NOT NULL,
    value integer DEFAULT 0 NOT NULL
);


--
-- Name: ttrss_counters_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_counters_cache (
    feed_id integer NOT NULL,
    owner_uid integer NOT NULL,
    updated timestamp without time zone NOT NULL,
    value integer DEFAULT 0 NOT NULL
);


--
-- Name: ttrss_enclosures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_enclosures (
    id integer NOT NULL,
    content_url text NOT NULL,
    content_type character varying(250) NOT NULL,
    title text NOT NULL,
    duration text NOT NULL,
    width integer DEFAULT 0 NOT NULL,
    height integer DEFAULT 0 NOT NULL,
    post_id integer NOT NULL
);


--
-- Name: ttrss_enclosures_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_enclosures_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_enclosures_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_enclosures_id_seq OWNED BY public.ttrss_enclosures.id;


--
-- Name: ttrss_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_entries (
    id integer NOT NULL,
    title text NOT NULL,
    guid text NOT NULL,
    link text NOT NULL,
    updated timestamp without time zone NOT NULL,
    content text NOT NULL,
    content_hash character varying(250) NOT NULL,
    cached_content text,
    no_orig_date boolean DEFAULT false NOT NULL,
    date_entered timestamp without time zone NOT NULL,
    date_updated timestamp without time zone NOT NULL,
    num_comments integer DEFAULT 0 NOT NULL,
    comments character varying(250) DEFAULT ''::character varying NOT NULL,
    plugin_data text,
    tsvector_combined tsvector,
    lang character varying(2),
    author character varying(250) DEFAULT ''::character varying NOT NULL
);


--
-- Name: ttrss_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_entries_id_seq OWNED BY public.ttrss_entries.id;


--
-- Name: ttrss_entry_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_entry_comments (
    id integer NOT NULL,
    ref_id integer NOT NULL,
    owner_uid integer NOT NULL,
    private boolean DEFAULT false NOT NULL,
    date_entered timestamp without time zone NOT NULL
);


--
-- Name: ttrss_entry_comments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_entry_comments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_entry_comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_entry_comments_id_seq OWNED BY public.ttrss_entry_comments.id;


--
-- Name: ttrss_error_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_error_log (
    id integer NOT NULL,
    owner_uid integer,
    errno integer NOT NULL,
    errstr text NOT NULL,
    filename text NOT NULL,
    lineno integer NOT NULL,
    context text NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: ttrss_error_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_error_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_error_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_error_log_id_seq OWNED BY public.ttrss_error_log.id;


--
-- Name: ttrss_feed_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_feed_categories (
    id integer NOT NULL,
    owner_uid integer NOT NULL,
    collapsed boolean DEFAULT false NOT NULL,
    order_id integer DEFAULT 0 NOT NULL,
    view_settings character varying(250) DEFAULT ''::character varying NOT NULL,
    parent_cat integer,
    title character varying(200) NOT NULL
);


--
-- Name: ttrss_feed_categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_feed_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_feed_categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_feed_categories_id_seq OWNED BY public.ttrss_feed_categories.id;


--
-- Name: ttrss_feedbrowser_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_feedbrowser_cache (
    feed_url text NOT NULL,
    title text NOT NULL,
    site_url text NOT NULL,
    subscribers integer NOT NULL
);


--
-- Name: ttrss_feeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_feeds (
    id integer NOT NULL,
    owner_uid integer NOT NULL,
    title character varying(200) NOT NULL,
    cat_id integer,
    feed_url text NOT NULL,
    icon_url character varying(250) DEFAULT ''::character varying NOT NULL,
    update_interval integer DEFAULT 0 NOT NULL,
    purge_interval integer DEFAULT 0 NOT NULL,
    last_updated timestamp without time zone,
    last_unconditional timestamp without time zone,
    last_error text DEFAULT ''::text NOT NULL,
    last_modified text DEFAULT ''::text NOT NULL,
    favicon_avg_color character varying(11) DEFAULT NULL::character varying,
    favicon_is_custom boolean,
    site_url character varying(250) DEFAULT ''::character varying NOT NULL,
    auth_login character varying(250) DEFAULT ''::character varying NOT NULL,
    parent_feed integer,
    private boolean DEFAULT false NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    include_in_digest boolean DEFAULT true NOT NULL,
    rtl_content boolean DEFAULT false NOT NULL,
    cache_images boolean DEFAULT false NOT NULL,
    hide_images boolean DEFAULT false NOT NULL,
    cache_content boolean DEFAULT false NOT NULL,
    last_viewed timestamp without time zone,
    last_update_started timestamp without time zone,
    last_successful_update timestamp without time zone,
    update_method integer DEFAULT 0 NOT NULL,
    always_display_enclosures boolean DEFAULT false NOT NULL,
    order_id integer DEFAULT 0 NOT NULL,
    mark_unread_on_update boolean DEFAULT false NOT NULL,
    update_on_checksum_change boolean DEFAULT false NOT NULL,
    strip_images boolean DEFAULT false NOT NULL,
    view_settings character varying(250) DEFAULT ''::character varying NOT NULL,
    pubsub_state integer DEFAULT 0 NOT NULL,
    favicon_last_checked timestamp without time zone,
    feed_language character varying(100) DEFAULT ''::character varying NOT NULL,
    auth_pass_encrypted boolean DEFAULT false NOT NULL,
    auth_pass text DEFAULT ''::text NOT NULL
);


--
-- Name: ttrss_feeds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_feeds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_feeds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_feeds_id_seq OWNED BY public.ttrss_feeds.id;


--
-- Name: ttrss_filter_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_filter_actions (
    id integer NOT NULL,
    name character varying(120) NOT NULL,
    description character varying(250) NOT NULL
);


--
-- Name: ttrss_filter_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_filter_types (
    id integer NOT NULL,
    name character varying(120) NOT NULL,
    description character varying(250) NOT NULL
);


--
-- Name: ttrss_filters2; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_filters2 (
    id integer NOT NULL,
    owner_uid integer NOT NULL,
    match_any_rule boolean DEFAULT false NOT NULL,
    inverse boolean DEFAULT false NOT NULL,
    title character varying(250) DEFAULT ''::character varying NOT NULL,
    order_id integer DEFAULT 0 NOT NULL,
    last_triggered timestamp without time zone,
    enabled boolean DEFAULT true NOT NULL
);


--
-- Name: ttrss_filters2_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_filters2_actions (
    id integer NOT NULL,
    filter_id integer NOT NULL,
    action_id integer DEFAULT 1 NOT NULL,
    action_param character varying(250) DEFAULT ''::character varying NOT NULL
);


--
-- Name: ttrss_filters2_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_filters2_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_filters2_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_filters2_actions_id_seq OWNED BY public.ttrss_filters2_actions.id;


--
-- Name: ttrss_filters2_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_filters2_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_filters2_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_filters2_id_seq OWNED BY public.ttrss_filters2.id;


--
-- Name: ttrss_filters2_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_filters2_rules (
    id integer NOT NULL,
    filter_id integer NOT NULL,
    reg_exp text NOT NULL,
    inverse boolean DEFAULT false NOT NULL,
    filter_type integer NOT NULL,
    feed_id integer,
    cat_id integer,
    match_on text,
    cat_filter boolean DEFAULT false NOT NULL
);


--
-- Name: ttrss_filters2_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_filters2_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_filters2_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_filters2_rules_id_seq OWNED BY public.ttrss_filters2_rules.id;


--
-- Name: ttrss_labels2; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_labels2 (
    id integer NOT NULL,
    owner_uid integer NOT NULL,
    fg_color character varying(15) DEFAULT ''::character varying NOT NULL,
    bg_color character varying(15) DEFAULT ''::character varying NOT NULL,
    caption character varying(250) NOT NULL
);


--
-- Name: ttrss_labels2_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_labels2_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_labels2_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_labels2_id_seq OWNED BY public.ttrss_labels2.id;


--
-- Name: ttrss_linked_feeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_linked_feeds (
    feed_url text NOT NULL,
    site_url text NOT NULL,
    title text NOT NULL,
    created timestamp without time zone NOT NULL,
    updated timestamp without time zone NOT NULL,
    instance_id integer NOT NULL,
    subscribers integer NOT NULL
);


--
-- Name: ttrss_linked_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_linked_instances (
    id integer NOT NULL,
    last_connected timestamp without time zone NOT NULL,
    last_status_in integer NOT NULL,
    last_status_out integer NOT NULL,
    access_key character varying(250) NOT NULL,
    access_url text NOT NULL
);


--
-- Name: ttrss_linked_instances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_linked_instances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_linked_instances_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_linked_instances_id_seq OWNED BY public.ttrss_linked_instances.id;


--
-- Name: ttrss_plugin_storage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_plugin_storage (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    owner_uid integer NOT NULL,
    content text NOT NULL
);


--
-- Name: ttrss_plugin_storage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_plugin_storage_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_plugin_storage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_plugin_storage_id_seq OWNED BY public.ttrss_plugin_storage.id;


--
-- Name: ttrss_prefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_prefs (
    pref_name character varying(250) NOT NULL,
    type_id integer NOT NULL,
    section_id integer DEFAULT 1 NOT NULL,
    access_level integer DEFAULT 0 NOT NULL,
    def_value text NOT NULL
);


--
-- Name: ttrss_prefs_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_prefs_sections (
    id integer NOT NULL,
    order_id integer NOT NULL,
    section_name character varying(100) NOT NULL
);


--
-- Name: ttrss_prefs_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_prefs_types (
    id integer NOT NULL,
    type_name character varying(100) NOT NULL
);


--
-- Name: ttrss_scheduled_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_scheduled_tasks (
    id integer NOT NULL,
    task_name character varying(250) NOT NULL,
    last_duration integer NOT NULL,
    last_rc integer NOT NULL,
    last_run timestamp without time zone DEFAULT now() NOT NULL,
    owner_uid integer,
    last_cron_expression character varying(250) NOT NULL
);


--
-- Name: ttrss_scheduled_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_scheduled_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_scheduled_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_scheduled_tasks_id_seq OWNED BY public.ttrss_scheduled_tasks.id;


--
-- Name: ttrss_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_sessions (
    id character varying(250) NOT NULL,
    data text,
    expire integer NOT NULL
);


--
-- Name: ttrss_settings_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_settings_profiles (
    id integer NOT NULL,
    title character varying(250) NOT NULL,
    owner_uid integer NOT NULL
);


--
-- Name: ttrss_settings_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_settings_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_settings_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_settings_profiles_id_seq OWNED BY public.ttrss_settings_profiles.id;


--
-- Name: ttrss_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_tags (
    id integer NOT NULL,
    tag_name character varying(250) NOT NULL,
    owner_uid integer NOT NULL,
    post_int_id integer NOT NULL
);


--
-- Name: ttrss_tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_tags_id_seq OWNED BY public.ttrss_tags.id;


--
-- Name: ttrss_user_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_user_entries (
    int_id integer NOT NULL,
    ref_id integer NOT NULL,
    uuid character varying(200) NOT NULL,
    feed_id integer,
    orig_feed_id integer,
    owner_uid integer NOT NULL,
    marked boolean DEFAULT false NOT NULL,
    published boolean DEFAULT false NOT NULL,
    tag_cache text NOT NULL,
    label_cache text NOT NULL,
    last_read timestamp without time zone,
    score integer DEFAULT 0 NOT NULL,
    last_marked timestamp without time zone,
    last_published timestamp without time zone,
    note text,
    unread boolean DEFAULT true NOT NULL
);


--
-- Name: ttrss_user_entries_int_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_user_entries_int_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_user_entries_int_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_user_entries_int_id_seq OWNED BY public.ttrss_user_entries.int_id;


--
-- Name: ttrss_user_labels2; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_user_labels2 (
    label_id integer NOT NULL,
    article_id integer NOT NULL
);


--
-- Name: ttrss_user_prefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_user_prefs (
    owner_uid integer NOT NULL,
    pref_name character varying(250) NOT NULL,
    profile integer,
    value text NOT NULL
);


--
-- Name: ttrss_user_prefs2; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_user_prefs2 (
    owner_uid integer NOT NULL,
    pref_name character varying(250) NOT NULL,
    profile integer,
    value text NOT NULL
);


--
-- Name: ttrss_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_users (
    id integer NOT NULL,
    login character varying(120) NOT NULL,
    pwd_hash character varying(250) NOT NULL,
    last_login timestamp without time zone,
    access_level integer DEFAULT 0 NOT NULL,
    email character varying(250) DEFAULT ''::character varying NOT NULL,
    full_name character varying(250) DEFAULT ''::character varying NOT NULL,
    email_digest boolean DEFAULT false NOT NULL,
    last_digest_sent timestamp without time zone,
    salt character varying(250) DEFAULT ''::character varying NOT NULL,
    twitter_oauth text,
    otp_enabled boolean DEFAULT false NOT NULL,
    otp_secret character varying(250) DEFAULT NULL::character varying,
    resetpass_token character varying(250) DEFAULT NULL::character varying,
    last_auth_attempt timestamp without time zone,
    created timestamp without time zone
);


--
-- Name: ttrss_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ttrss_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ttrss_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ttrss_users_id_seq OWNED BY public.ttrss_users.id;


--
-- Name: ttrss_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ttrss_version (
    schema_version integer NOT NULL
);


--
-- Name: ttrss_access_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_access_keys ALTER COLUMN id SET DEFAULT nextval('public.ttrss_access_keys_id_seq'::regclass);


--
-- Name: ttrss_app_passwords id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_app_passwords ALTER COLUMN id SET DEFAULT nextval('public.ttrss_app_passwords_id_seq'::regclass);


--
-- Name: ttrss_enclosures id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_enclosures ALTER COLUMN id SET DEFAULT nextval('public.ttrss_enclosures_id_seq'::regclass);


--
-- Name: ttrss_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_entries ALTER COLUMN id SET DEFAULT nextval('public.ttrss_entries_id_seq'::regclass);


--
-- Name: ttrss_entry_comments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_entry_comments ALTER COLUMN id SET DEFAULT nextval('public.ttrss_entry_comments_id_seq'::regclass);


--
-- Name: ttrss_error_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_error_log ALTER COLUMN id SET DEFAULT nextval('public.ttrss_error_log_id_seq'::regclass);


--
-- Name: ttrss_feed_categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_feed_categories ALTER COLUMN id SET DEFAULT nextval('public.ttrss_feed_categories_id_seq'::regclass);


--
-- Name: ttrss_feeds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_feeds ALTER COLUMN id SET DEFAULT nextval('public.ttrss_feeds_id_seq'::regclass);


--
-- Name: ttrss_filters2 id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filters2 ALTER COLUMN id SET DEFAULT nextval('public.ttrss_filters2_id_seq'::regclass);


--
-- Name: ttrss_filters2_actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filters2_actions ALTER COLUMN id SET DEFAULT nextval('public.ttrss_filters2_actions_id_seq'::regclass);


--
-- Name: ttrss_filters2_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filters2_rules ALTER COLUMN id SET DEFAULT nextval('public.ttrss_filters2_rules_id_seq'::regclass);


--
-- Name: ttrss_labels2 id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_labels2 ALTER COLUMN id SET DEFAULT nextval('public.ttrss_labels2_id_seq'::regclass);


--
-- Name: ttrss_linked_instances id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_linked_instances ALTER COLUMN id SET DEFAULT nextval('public.ttrss_linked_instances_id_seq'::regclass);


--
-- Name: ttrss_plugin_storage id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_plugin_storage ALTER COLUMN id SET DEFAULT nextval('public.ttrss_plugin_storage_id_seq'::regclass);


--
-- Name: ttrss_scheduled_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_scheduled_tasks ALTER COLUMN id SET DEFAULT nextval('public.ttrss_scheduled_tasks_id_seq'::regclass);


--
-- Name: ttrss_settings_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_settings_profiles ALTER COLUMN id SET DEFAULT nextval('public.ttrss_settings_profiles_id_seq'::regclass);


--
-- Name: ttrss_tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_tags ALTER COLUMN id SET DEFAULT nextval('public.ttrss_tags_id_seq'::regclass);


--
-- Name: ttrss_user_entries int_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_user_entries ALTER COLUMN int_id SET DEFAULT nextval('public.ttrss_user_entries_int_id_seq'::regclass);


--
-- Name: ttrss_users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_users ALTER COLUMN id SET DEFAULT nextval('public.ttrss_users_id_seq'::regclass);


--
-- Name: ttrss_access_keys ttrss_access_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_access_keys
    ADD CONSTRAINT ttrss_access_keys_pkey PRIMARY KEY (id);


--
-- Name: ttrss_app_passwords ttrss_app_passwords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_app_passwords
    ADD CONSTRAINT ttrss_app_passwords_pkey PRIMARY KEY (id);


--
-- Name: ttrss_archived_feeds ttrss_archived_feeds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_archived_feeds
    ADD CONSTRAINT ttrss_archived_feeds_pkey PRIMARY KEY (id);


--
-- Name: ttrss_enclosures ttrss_enclosures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_enclosures
    ADD CONSTRAINT ttrss_enclosures_pkey PRIMARY KEY (id);


--
-- Name: ttrss_entries ttrss_entries_guid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_entries
    ADD CONSTRAINT ttrss_entries_guid_key UNIQUE (guid);


--
-- Name: ttrss_entries ttrss_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_entries
    ADD CONSTRAINT ttrss_entries_pkey PRIMARY KEY (id);


--
-- Name: ttrss_entry_comments ttrss_entry_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_entry_comments
    ADD CONSTRAINT ttrss_entry_comments_pkey PRIMARY KEY (id);


--
-- Name: ttrss_error_log ttrss_error_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_error_log
    ADD CONSTRAINT ttrss_error_log_pkey PRIMARY KEY (id);


--
-- Name: ttrss_feed_categories ttrss_feed_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_feed_categories
    ADD CONSTRAINT ttrss_feed_categories_pkey PRIMARY KEY (id);


--
-- Name: ttrss_feedbrowser_cache ttrss_feedbrowser_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_feedbrowser_cache
    ADD CONSTRAINT ttrss_feedbrowser_cache_pkey PRIMARY KEY (feed_url);


--
-- Name: ttrss_feeds ttrss_feeds_feed_url_owner_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_feeds
    ADD CONSTRAINT ttrss_feeds_feed_url_owner_uid_key UNIQUE (feed_url, owner_uid);


--
-- Name: ttrss_feeds ttrss_feeds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_feeds
    ADD CONSTRAINT ttrss_feeds_pkey PRIMARY KEY (id);


--
-- Name: ttrss_filter_actions ttrss_filter_actions_description_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filter_actions
    ADD CONSTRAINT ttrss_filter_actions_description_key UNIQUE (description);


--
-- Name: ttrss_filter_actions ttrss_filter_actions_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filter_actions
    ADD CONSTRAINT ttrss_filter_actions_name_key UNIQUE (name);


--
-- Name: ttrss_filter_actions ttrss_filter_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filter_actions
    ADD CONSTRAINT ttrss_filter_actions_pkey PRIMARY KEY (id);


--
-- Name: ttrss_filter_types ttrss_filter_types_description_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filter_types
    ADD CONSTRAINT ttrss_filter_types_description_key UNIQUE (description);


--
-- Name: ttrss_filter_types ttrss_filter_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filter_types
    ADD CONSTRAINT ttrss_filter_types_name_key UNIQUE (name);


--
-- Name: ttrss_filter_types ttrss_filter_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filter_types
    ADD CONSTRAINT ttrss_filter_types_pkey PRIMARY KEY (id);


--
-- Name: ttrss_filters2_actions ttrss_filters2_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filters2_actions
    ADD CONSTRAINT ttrss_filters2_actions_pkey PRIMARY KEY (id);


--
-- Name: ttrss_filters2 ttrss_filters2_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filters2
    ADD CONSTRAINT ttrss_filters2_pkey PRIMARY KEY (id);


--
-- Name: ttrss_filters2_rules ttrss_filters2_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filters2_rules
    ADD CONSTRAINT ttrss_filters2_rules_pkey PRIMARY KEY (id);


--
-- Name: ttrss_labels2 ttrss_labels2_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_labels2
    ADD CONSTRAINT ttrss_labels2_pkey PRIMARY KEY (id);


--
-- Name: ttrss_linked_instances ttrss_linked_instances_access_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_linked_instances
    ADD CONSTRAINT ttrss_linked_instances_access_key_key UNIQUE (access_key);


--
-- Name: ttrss_linked_instances ttrss_linked_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_linked_instances
    ADD CONSTRAINT ttrss_linked_instances_pkey PRIMARY KEY (id);


--
-- Name: ttrss_plugin_storage ttrss_plugin_storage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_plugin_storage
    ADD CONSTRAINT ttrss_plugin_storage_pkey PRIMARY KEY (id);


--
-- Name: ttrss_prefs ttrss_prefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_prefs
    ADD CONSTRAINT ttrss_prefs_pkey PRIMARY KEY (pref_name);


--
-- Name: ttrss_prefs_sections ttrss_prefs_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_prefs_sections
    ADD CONSTRAINT ttrss_prefs_sections_pkey PRIMARY KEY (id);


--
-- Name: ttrss_prefs_types ttrss_prefs_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_prefs_types
    ADD CONSTRAINT ttrss_prefs_types_pkey PRIMARY KEY (id);


--
-- Name: ttrss_scheduled_tasks ttrss_scheduled_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_scheduled_tasks
    ADD CONSTRAINT ttrss_scheduled_tasks_pkey PRIMARY KEY (id);


--
-- Name: ttrss_scheduled_tasks ttrss_scheduled_tasks_task_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_scheduled_tasks
    ADD CONSTRAINT ttrss_scheduled_tasks_task_name_key UNIQUE (task_name);


--
-- Name: ttrss_sessions ttrss_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_sessions
    ADD CONSTRAINT ttrss_sessions_pkey PRIMARY KEY (id);


--
-- Name: ttrss_settings_profiles ttrss_settings_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_settings_profiles
    ADD CONSTRAINT ttrss_settings_profiles_pkey PRIMARY KEY (id);


--
-- Name: ttrss_tags ttrss_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_tags
    ADD CONSTRAINT ttrss_tags_pkey PRIMARY KEY (id);


--
-- Name: ttrss_user_entries ttrss_user_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_user_entries
    ADD CONSTRAINT ttrss_user_entries_pkey PRIMARY KEY (int_id);


--
-- Name: ttrss_users ttrss_users_login_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_users
    ADD CONSTRAINT ttrss_users_login_key UNIQUE (login);


--
-- Name: ttrss_users ttrss_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_users
    ADD CONSTRAINT ttrss_users_pkey PRIMARY KEY (id);


--
-- Name: ttrss_cat_counters_cache_owner_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_cat_counters_cache_owner_uid_idx ON public.ttrss_cat_counters_cache USING btree (owner_uid);


--
-- Name: ttrss_counters_cache_feed_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_counters_cache_feed_id_idx ON public.ttrss_counters_cache USING btree (feed_id);


--
-- Name: ttrss_counters_cache_owner_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_counters_cache_owner_uid_idx ON public.ttrss_counters_cache USING btree (owner_uid);


--
-- Name: ttrss_counters_cache_value_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_counters_cache_value_idx ON public.ttrss_counters_cache USING btree (value);


--
-- Name: ttrss_enclosures_post_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_enclosures_post_id_idx ON public.ttrss_enclosures USING btree (post_id);


--
-- Name: ttrss_entries_date_entered_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_entries_date_entered_index ON public.ttrss_entries USING btree (date_entered);


--
-- Name: ttrss_entries_tsvector_combined_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_entries_tsvector_combined_idx ON public.ttrss_entries USING gin (tsvector_combined);


--
-- Name: ttrss_entries_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_entries_updated_idx ON public.ttrss_entries USING btree (updated);


--
-- Name: ttrss_entry_comments_ref_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_entry_comments_ref_id_index ON public.ttrss_entry_comments USING btree (ref_id);


--
-- Name: ttrss_feeds_cat_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_feeds_cat_id_idx ON public.ttrss_feeds USING btree (cat_id);


--
-- Name: ttrss_feeds_owner_uid_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_feeds_owner_uid_index ON public.ttrss_feeds USING btree (owner_uid);


--
-- Name: ttrss_sessions_expire_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_sessions_expire_index ON public.ttrss_sessions USING btree (expire);


--
-- Name: ttrss_tags_owner_uid_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_tags_owner_uid_index ON public.ttrss_tags USING btree (owner_uid);


--
-- Name: ttrss_tags_post_int_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_tags_post_int_id_idx ON public.ttrss_tags USING btree (post_int_id);


--
-- Name: ttrss_user_entries_feed_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_user_entries_feed_id ON public.ttrss_user_entries USING btree (feed_id);


--
-- Name: ttrss_user_entries_owner_uid_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_user_entries_owner_uid_index ON public.ttrss_user_entries USING btree (owner_uid);


--
-- Name: ttrss_user_entries_ref_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_user_entries_ref_id_index ON public.ttrss_user_entries USING btree (ref_id);


--
-- Name: ttrss_user_entries_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_user_entries_unread_idx ON public.ttrss_user_entries USING btree (unread);


--
-- Name: ttrss_user_labels2_article_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_user_labels2_article_id_idx ON public.ttrss_user_labels2 USING btree (article_id);


--
-- Name: ttrss_user_labels2_label_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_user_labels2_label_id_idx ON public.ttrss_user_labels2 USING btree (label_id);


--
-- Name: ttrss_user_prefs2_composite_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ttrss_user_prefs2_composite_idx ON public.ttrss_user_prefs2 USING btree (pref_name, owner_uid, COALESCE(profile, '-1'::integer));


--
-- Name: ttrss_user_prefs2_owner_uid_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_user_prefs2_owner_uid_index ON public.ttrss_user_prefs2 USING btree (owner_uid);


--
-- Name: ttrss_user_prefs2_pref_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_user_prefs2_pref_name_idx ON public.ttrss_user_prefs2 USING btree (pref_name);


--
-- Name: ttrss_user_prefs_owner_uid_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_user_prefs_owner_uid_index ON public.ttrss_user_prefs USING btree (owner_uid);


--
-- Name: ttrss_user_prefs_pref_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ttrss_user_prefs_pref_name_idx ON public.ttrss_user_prefs USING btree (pref_name);


--
-- Name: ttrss_access_keys ttrss_access_keys_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_access_keys
    ADD CONSTRAINT ttrss_access_keys_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_app_passwords ttrss_app_passwords_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_app_passwords
    ADD CONSTRAINT ttrss_app_passwords_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_archived_feeds ttrss_archived_feeds_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_archived_feeds
    ADD CONSTRAINT ttrss_archived_feeds_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_cat_counters_cache ttrss_cat_counters_cache_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_cat_counters_cache
    ADD CONSTRAINT ttrss_cat_counters_cache_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_counters_cache ttrss_counters_cache_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_counters_cache
    ADD CONSTRAINT ttrss_counters_cache_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_enclosures ttrss_enclosures_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_enclosures
    ADD CONSTRAINT ttrss_enclosures_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.ttrss_entries(id) ON DELETE CASCADE;


--
-- Name: ttrss_entry_comments ttrss_entry_comments_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_entry_comments
    ADD CONSTRAINT ttrss_entry_comments_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_entry_comments ttrss_entry_comments_ref_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_entry_comments
    ADD CONSTRAINT ttrss_entry_comments_ref_id_fkey FOREIGN KEY (ref_id) REFERENCES public.ttrss_entries(id) ON DELETE CASCADE;


--
-- Name: ttrss_error_log ttrss_error_log_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_error_log
    ADD CONSTRAINT ttrss_error_log_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE SET NULL;


--
-- Name: ttrss_feed_categories ttrss_feed_categories_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_feed_categories
    ADD CONSTRAINT ttrss_feed_categories_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_feed_categories ttrss_feed_categories_parent_cat_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_feed_categories
    ADD CONSTRAINT ttrss_feed_categories_parent_cat_fkey FOREIGN KEY (parent_cat) REFERENCES public.ttrss_feed_categories(id) ON DELETE SET NULL;


--
-- Name: ttrss_feeds ttrss_feeds_cat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_feeds
    ADD CONSTRAINT ttrss_feeds_cat_id_fkey FOREIGN KEY (cat_id) REFERENCES public.ttrss_feed_categories(id) ON DELETE SET NULL;


--
-- Name: ttrss_feeds ttrss_feeds_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_feeds
    ADD CONSTRAINT ttrss_feeds_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_feeds ttrss_feeds_parent_feed_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_feeds
    ADD CONSTRAINT ttrss_feeds_parent_feed_fkey FOREIGN KEY (parent_feed) REFERENCES public.ttrss_feeds(id) ON DELETE SET NULL;


--
-- Name: ttrss_filters2_actions ttrss_filters2_actions_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filters2_actions
    ADD CONSTRAINT ttrss_filters2_actions_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.ttrss_filter_actions(id) ON DELETE CASCADE;


--
-- Name: ttrss_filters2_actions ttrss_filters2_actions_filter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filters2_actions
    ADD CONSTRAINT ttrss_filters2_actions_filter_id_fkey FOREIGN KEY (filter_id) REFERENCES public.ttrss_filters2(id) ON DELETE CASCADE;


--
-- Name: ttrss_filters2 ttrss_filters2_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filters2
    ADD CONSTRAINT ttrss_filters2_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_filters2_rules ttrss_filters2_rules_cat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filters2_rules
    ADD CONSTRAINT ttrss_filters2_rules_cat_id_fkey FOREIGN KEY (cat_id) REFERENCES public.ttrss_feed_categories(id) ON DELETE CASCADE;


--
-- Name: ttrss_filters2_rules ttrss_filters2_rules_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filters2_rules
    ADD CONSTRAINT ttrss_filters2_rules_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.ttrss_feeds(id) ON DELETE CASCADE;


--
-- Name: ttrss_filters2_rules ttrss_filters2_rules_filter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filters2_rules
    ADD CONSTRAINT ttrss_filters2_rules_filter_id_fkey FOREIGN KEY (filter_id) REFERENCES public.ttrss_filters2(id) ON DELETE CASCADE;


--
-- Name: ttrss_filters2_rules ttrss_filters2_rules_filter_type_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_filters2_rules
    ADD CONSTRAINT ttrss_filters2_rules_filter_type_fkey FOREIGN KEY (filter_type) REFERENCES public.ttrss_filter_types(id);


--
-- Name: ttrss_labels2 ttrss_labels2_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_labels2
    ADD CONSTRAINT ttrss_labels2_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_linked_feeds ttrss_linked_feeds_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_linked_feeds
    ADD CONSTRAINT ttrss_linked_feeds_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.ttrss_linked_instances(id) ON DELETE CASCADE;


--
-- Name: ttrss_plugin_storage ttrss_plugin_storage_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_plugin_storage
    ADD CONSTRAINT ttrss_plugin_storage_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_prefs ttrss_prefs_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_prefs
    ADD CONSTRAINT ttrss_prefs_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.ttrss_prefs_sections(id);


--
-- Name: ttrss_prefs ttrss_prefs_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_prefs
    ADD CONSTRAINT ttrss_prefs_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.ttrss_prefs_types(id);


--
-- Name: ttrss_scheduled_tasks ttrss_scheduled_tasks_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_scheduled_tasks
    ADD CONSTRAINT ttrss_scheduled_tasks_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_settings_profiles ttrss_settings_profiles_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_settings_profiles
    ADD CONSTRAINT ttrss_settings_profiles_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_tags ttrss_tags_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_tags
    ADD CONSTRAINT ttrss_tags_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_tags ttrss_tags_post_int_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_tags
    ADD CONSTRAINT ttrss_tags_post_int_id_fkey FOREIGN KEY (post_int_id) REFERENCES public.ttrss_user_entries(int_id) ON DELETE CASCADE;


--
-- Name: ttrss_user_entries ttrss_user_entries_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_user_entries
    ADD CONSTRAINT ttrss_user_entries_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.ttrss_feeds(id) ON DELETE CASCADE;


--
-- Name: ttrss_user_entries ttrss_user_entries_orig_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_user_entries
    ADD CONSTRAINT ttrss_user_entries_orig_feed_id_fkey FOREIGN KEY (orig_feed_id) REFERENCES public.ttrss_archived_feeds(id) ON DELETE SET NULL;


--
-- Name: ttrss_user_entries ttrss_user_entries_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_user_entries
    ADD CONSTRAINT ttrss_user_entries_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_user_entries ttrss_user_entries_ref_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_user_entries
    ADD CONSTRAINT ttrss_user_entries_ref_id_fkey FOREIGN KEY (ref_id) REFERENCES public.ttrss_entries(id) ON DELETE CASCADE;


--
-- Name: ttrss_user_labels2 ttrss_user_labels2_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_user_labels2
    ADD CONSTRAINT ttrss_user_labels2_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.ttrss_entries(id) ON DELETE CASCADE;


--
-- Name: ttrss_user_labels2 ttrss_user_labels2_label_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_user_labels2
    ADD CONSTRAINT ttrss_user_labels2_label_id_fkey FOREIGN KEY (label_id) REFERENCES public.ttrss_labels2(id) ON DELETE CASCADE;


--
-- Name: ttrss_user_prefs2 ttrss_user_prefs2_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_user_prefs2
    ADD CONSTRAINT ttrss_user_prefs2_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_user_prefs2 ttrss_user_prefs2_profile_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_user_prefs2
    ADD CONSTRAINT ttrss_user_prefs2_profile_fkey FOREIGN KEY (profile) REFERENCES public.ttrss_settings_profiles(id) ON DELETE CASCADE;


--
-- Name: ttrss_user_prefs ttrss_user_prefs_owner_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_user_prefs
    ADD CONSTRAINT ttrss_user_prefs_owner_uid_fkey FOREIGN KEY (owner_uid) REFERENCES public.ttrss_users(id) ON DELETE CASCADE;


--
-- Name: ttrss_user_prefs ttrss_user_prefs_pref_name_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_user_prefs
    ADD CONSTRAINT ttrss_user_prefs_pref_name_fkey FOREIGN KEY (pref_name) REFERENCES public.ttrss_prefs(pref_name) ON DELETE CASCADE;


--
-- Name: ttrss_user_prefs ttrss_user_prefs_profile_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ttrss_user_prefs
    ADD CONSTRAINT ttrss_user_prefs_profile_fkey FOREIGN KEY (profile) REFERENCES public.ttrss_settings_profiles(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

