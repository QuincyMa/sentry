import {browserHistory} from 'react-router';
import {omit, pickBy, uniq} from 'lodash';
import Cookies from 'js-cookie';
import React from 'react';
import Reflux from 'reflux';
import classNames from 'classnames';
import createReactClass from 'create-react-class';
import qs from 'query-string';

import {Client} from 'app/api';
import {Panel, PanelBody} from 'app/components/panels';
import {analytics} from 'app/utils/analytics';
import {t} from 'app/locale';
import {fetchProject} from 'app/actionCreators/projects';
import {fetchTags} from 'app/actionCreators/tags';
import {fetchOrgMembers} from 'app/actionCreators/members';
import ConfigStore from 'app/stores/configStore';
import GlobalSelectionStore from 'app/stores/globalSelectionStore';
import GroupStore from 'app/stores/groupStore';
import SelectedGroupStore from 'app/stores/selectedGroupStore';
import TagStore from 'app/stores/tagStore';
import EmptyStateWarning from 'app/components/emptyStateWarning';
import LoadingError from 'app/components/loadingError';
import LoadingIndicator from 'app/components/loadingIndicator';
import Pagination from 'app/components/pagination';
import SentryTypes from 'app/sentryTypes';
import StreamGroup from 'app/components/stream/group';
import StreamActions from 'app/views/stream/actions';
import StreamFilters from 'app/views/stream/filters';
import StreamSidebar from 'app/views/stream/sidebar';
import parseApiError from 'app/utils/parseApiError';
import parseLinkHeader from 'app/utils/parseLinkHeader';
import utils from 'app/utils';
import withOrganization from 'app/utils/withOrganization';

const MAX_ITEMS = 25;
const DEFAULT_QUERY = 'is:unresolved';
const DEFAULT_SORT = 'date';
const DEFAULT_STATS_PERIOD = '24h';
const STATS_PERIODS = new Set(['14d', '24h']);

const OrganizationStream = createReactClass({
  displayName: 'OrganizationStream',

  propTypes: {
    organization: SentryTypes.Organization,
  },

  mixins: [
    Reflux.listenTo(GlobalSelectionStore, 'onSelectionChange'),
    Reflux.listenTo(GroupStore, 'onGroupChange'),
    Reflux.listenTo(SelectedGroupStore, 'onSelectedGroupChange'),
    Reflux.listenTo(TagStore, 'onTagsChange'),
  ],

  getInitialState() {
    let realtimeActiveCookie = Cookies.get('realtimeActive');
    let realtimeActive =
      typeof realtimeActiveCookie === 'undefined'
        ? false
        : realtimeActiveCookie === 'true';

    return {
      groupIds: [],
      isDefaultSearch: false,
      loading: false,
      selectAllActive: false,
      multiSelected: false,
      realtimeActive,
      pageLinks: '',
      queryCount: null,
      error: false,
      selection: GlobalSelectionStore.get(),
      isSidebarVisible: false,
      savedSearchList: [],
      processingIssues: null,
      tagsLoading: true,
      memberList: null,
      tags: TagStore.getAllTags(),
      // the project for the selected issues
      // Will only be set if selected issues all belong
      // to one project.
      selectedProject: null,
    };
  },

  componentDidMount() {
    this.api = new Client();
    this._streamManager = new utils.StreamManager(GroupStore);
    this._poller = new utils.CursorPoller({
      success: this.onRealtimePoll,
    });

    if (!this.state.loading) {
      this.fetchData();
      fetchTags(this.props.organization.slug);

      fetchOrgMembers(this.api, this.props.organization.slug).then(members => {
        let memberList = members.reduce((acc, member) => {
          for (let project of member.projects) {
            if (acc[project] === undefined) {
              acc[project] = [];
            }
            acc[project].push(member.user);
          }
          return acc;
        }, {});
        this.setState({memberList});
      });
    }
  },

  componentDidUpdate(prevProps, prevState) {
    if (prevState.realtimeActive !== this.state.realtimeActive) {
      // User toggled realtime button
      if (this.state.realtimeActive) {
        this.resumePolling();
      } else {
        this._poller.disable();
      }
    }

    if (prevProps.location.search != this.props.location.search) {
      this.fetchData();
    }
  },

  componentWillUnmount() {
    this._poller.disable();
    this.projectCache = {};
    GroupStore.reset();
    this.api.clear();
  },

  // Memoize projects fetched as selections are made
  // This data is fed into the action toolbar for release data.
  projectCache: {},

  getQuery() {
    return this.props.location.query.query || DEFAULT_QUERY;
  },

  getSort() {
    return this.props.location.query.sort || DEFAULT_SORT;
  },

  getGroupStatsPeriod() {
    let currentPeriod = this.props.location.query.groupStatsPeriod;
    return STATS_PERIODS.has(currentPeriod) ? currentPeriod : DEFAULT_STATS_PERIOD;
  },

  getEndpointParams() {
    let selection = this.state.selection;

    let params = {
      project: selection.projects,
      environment: selection.environments,
      query: this.getQuery(),
      ...selection.datetime,
    };
    if (selection.datetime.period) {
      delete params.period;
      params.statsPeriod = selection.datetime.period;
    }

    let sort = this.getSort();
    if (sort !== DEFAULT_SORT) {
      params.sort = sort;
    }

    let groupStatsPeriod = this.getGroupStatsPeriod();
    if (groupStatsPeriod !== DEFAULT_STATS_PERIOD) {
      params.groupStatsPeriod = groupStatsPeriod;
    }

    // only include defined values.
    return pickBy(params, v => utils.defined(v));
  },

  getAccess() {
    return new Set(this.props.organization.access);
  },

  fetchData() {
    GroupStore.loadInitialData([]);

    this.setState({
      loading: true,
      queryCount: null,
      error: false,
    });

    let requestParams = {
      ...this.getEndpointParams(),
      limit: MAX_ITEMS,
      shortIdLookup: '1',
    };

    let currentQuery = this.props.location.query || {};
    if ('cursor' in currentQuery) {
      requestParams.cursor = currentQuery.cursor;
    }

    if (this.lastRequest) {
      this.lastRequest.cancel();
    }

    this._poller.disable();

    this.lastRequest = this.api.request(this.getGroupListEndpoint(), {
      method: 'GET',
      data: qs.stringify(requestParams),
      success: (data, ignore, jqXHR) => {
        // if this is a direct hit, we redirect to the intended result directly.
        // we have to use the project slug from the result data instead of the
        // the current props one as the shortIdLookup can return results for
        // different projects.
        if (jqXHR.getResponseHeader('X-Sentry-Direct-Hit') === '1') {
          if (data && data[0].matchingEventId) {
            let {project, id, matchingEventId} = data[0];
            let redirect = `/${this.props.params
              .orgId}/${project.slug}/issues/${id}/events/${matchingEventId}/`;

            // TODO include global search query params
            browserHistory.replace(redirect);
            return;
          }
        }

        this._streamManager.push(data);

        let queryCount = jqXHR.getResponseHeader('X-Hits');
        let queryMaxCount = jqXHR.getResponseHeader('X-Max-Hits');

        this.setState({
          error: false,
          loading: false,
          queryCount:
            typeof queryCount !== 'undefined' ? parseInt(queryCount, 10) || 0 : 0,
          queryMaxCount:
            typeof queryMaxCount !== 'undefined' ? parseInt(queryMaxCount, 10) || 0 : 0,
          pageLinks: jqXHR.getResponseHeader('Link'),
        });
      },
      error: err => {
        this.setState({
          error: parseApiError(err),
          loading: false,
        });
      },
      complete: jqXHR => {
        this.lastRequest = null;

        this.resumePolling();
      },
    });
  },

  resumePolling() {
    if (!this.state.pageLinks) return;

    // Only resume polling if we're on the first page of results
    let links = parseLinkHeader(this.state.pageLinks);
    if (links && !links.previous.results && this.state.realtimeActive) {
      this._poller.setEndpoint(links.previous.href);
      this._poller.enable();
    }
  },

  getGroupListEndpoint() {
    let params = this.props.params;

    return `/organizations/${params.orgId}/issues/`;
  },

  onRealtimeChange(realtime) {
    Cookies.set('realtimeActive', realtime.toString());
    this.setState({
      realtimeActive: realtime,
    });
  },

  onSelectStatsPeriod(period) {
    if (period != this.getGroupStatsPeriod()) {
      this.transitionTo({groupStatsPeriod: period});
    }
  },

  onRealtimePoll(data, links) {
    this._streamManager.unshift(data);
    if (!utils.valueIsEqual(this.state.pageLinks, links, true)) {
      this.setState({
        pageLinks: links,
      });
    }
  },

  onGroupChange() {
    let groupIds = this._streamManager.getAllItems().map(item => item.id);
    if (!utils.valueIsEqual(groupIds, this.state.groupIds)) {
      this.setState({
        groupIds,
      });
    }
  },

  onSelectionChange(selection) {
    this.setState({selection}, this.transitionTo);
  },

  onSearch(query) {
    if (query === this.state.query) {
      // if query is the same, just re-fetch data
      this.fetchData();
    } else {
      this.transitionTo({query});
    }
  },

  onSortChange(sort) {
    this.transitionTo({sort});
  },

  onTagsChange(tags) {
    // Exclude the environment tag as it lives in global search.
    this.setState({
      tags: omit(tags, 'environment'),
      tagsLoading: false,
    });
  },

  onSidebarToggle() {
    let {organization} = this.props;
    this.setState({
      isSidebarVisible: !this.state.isSidebarVisible,
    });
    analytics('issue.search_sidebar_clicked', {
      org_id: parseInt(organization.id, 10),
    });
  },

  onSelectedGroupChange() {
    let selected = SelectedGroupStore.getSelectedIds();
    let projects = [...selected]
      .map(id => GroupStore.get(id))
      .map(group => group.project.slug);

    let uniqProjects = uniq(projects);

    // we only want selectedProject set if there is 1 project
    // more or fewer should result in a null so that the action toolbar
    // can behave correctly.
    if (uniqProjects.length !== 1) {
      this.setState({selectedProject: null});
      return;
    }
    this.fetchProject(uniqProjects[0]);
  },

  fetchProject(projectSlug) {
    if (projectSlug in this.projectCache) {
      this.setState({selectedProject: this.projectCache[projectSlug]});
      return;
    }

    let orgId = this.props.organization.slug;
    fetchProject(this.api, orgId, projectSlug).then(project => {
      this.projectCache[project.slug] = project;
      this.setState({selectedProject: project});
    });
  },

  /**
   * Returns true if all results in the current query are visible/on this page
   */
  allResultsVisible() {
    if (!this.state.pageLinks) return false;

    let links = parseLinkHeader(this.state.pageLinks);
    return links && !links.previous.results && !links.next.results;
  },

  transitionTo(newParams = {}) {
    let query = {
      ...this.getEndpointParams(),
      ...newParams,
    };
    let {organization} = this.props;

    let path = `/organizations/${organization.slug}/issues/`;
    browserHistory.push({
      pathname: path,
      query,
    });

    // Refetch data as simply pushing browserHistory doesn't
    // update props.
    this.fetchData();
  },

  renderGroupNodes(ids, groupStatsPeriod) {
    // Restrict this guide to only show for new users (joined<30 days) and add guide anhor only to the first issue
    let userDateJoined = new Date(ConfigStore.get('user').dateJoined);
    let dateCutoff = new Date();
    dateCutoff.setDate(dateCutoff.getDate() - 30);

    let topIssue = ids[0];
    let {memberList} = this.state;

    let {orgId} = this.props.params;
    let groupNodes = ids.map(id => {
      let hasGuideAnchor = userDateJoined > dateCutoff && id === topIssue;

      let group = GroupStore.get(id);
      let members = memberList[group.project.slug] || [];

      return (
        <StreamGroup
          key={id}
          id={id}
          orgId={orgId}
          statsPeriod={groupStatsPeriod}
          query={this.getQuery()}
          hasGuideAnchor={hasGuideAnchor}
          memberList={members}
        />
      );
    });
    return <PanelBody className="ref-group-list">{groupNodes}</PanelBody>;
  },

  renderEmpty() {
    return (
      <EmptyStateWarning>
        <p>{t('Sorry, no issues match your filters.')}</p>
      </EmptyStateWarning>
    );
  },

  renderLoading() {
    return <LoadingIndicator />;
  },

  renderStreamBody() {
    let body;

    if (this.state.loading) {
      body = this.renderLoading();
    } else if (this.state.error) {
      body = <LoadingError message={this.state.error} onRetry={this.fetchData} />;
    } else if (this.state.groupIds.length > 0) {
      body = this.renderGroupNodes(this.state.groupIds, this.getGroupStatsPeriod());
    } else {
      body = this.renderEmpty();
    }
    return body;
  },

  onSavedSearchCreate() {
    // TODO implement
  },

  render() {
    // global loading
    if (this.state.loading) {
      return this.renderLoading();
    }
    let params = this.props.params;
    let classes = ['stream-row'];
    if (this.state.isSidebarVisible) classes.push('show-sidebar');
    let {orgId} = this.props.params;
    let access = this.getAccess();
    let query = this.getQuery();

    // If we have a selected project we can get release data
    let hasReleases = false;
    let projectId = null;
    let latestRelease = null;
    let {selectedProject} = this.state;
    if (selectedProject) {
      let features = new Set(selectedProject.features);
      hasReleases = features.has('releases');
      latestRelease = selectedProject.latestRelease;
      projectId = selectedProject.slug;
    }

    return (
      <div className={classNames(classes)}>
        <div className="stream-content">
          <StreamFilters
            access={access}
            orgId={orgId}
            query={query}
            sort={this.getSort()}
            queryCount={this.state.queryCount}
            queryMaxCount={this.state.queryMaxCount}
            onSortChange={this.onSortChange}
            onSearch={this.onSearch}
            onSavedSearchCreate={this.onSavedSearchCreate}
            onSidebarToggle={this.onSidebarToggle}
            isSearchDisabled={this.state.isSidebarVisible}
            savedSearchList={this.state.savedSearchList}
          />
          <Panel>
            <StreamActions
              orgId={params.orgId}
              projectId={projectId}
              hasReleases={hasReleases}
              latestRelease={latestRelease}
              query={query}
              queryCount={this.state.queryCount}
              onSelectStatsPeriod={this.onSelectStatsPeriod}
              onRealtimeChange={this.onRealtimeChange}
              realtimeActive={this.state.realtimeActive}
              statsPeriod={this.getGroupStatsPeriod()}
              groupIds={this.state.groupIds}
              allResultsVisible={this.allResultsVisible()}
            />
            <PanelBody>{this.renderStreamBody()}</PanelBody>
          </Panel>
          <Pagination pageLinks={this.state.pageLinks} />
        </div>
        <StreamSidebar
          loading={this.state.tagsLoading}
          tags={this.state.tags}
          query={query}
          onQueryChange={this.onSearch}
          orgId={params.orgId}
        />
      </div>
    );
  },
});

export default withOrganization(OrganizationStream);
export {OrganizationStream};
