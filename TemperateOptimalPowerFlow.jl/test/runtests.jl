using Test
using TemperateOptimalPowerFlow
using PowerModels
using Ipopt


@testset "TemperateOptimalPowerFlow.jl" begin

    @testset "prepare_model" begin
        # import MatPower test case
        network = parse_file("case3.m")
        @test isa(network, Dict)
        @test "gen_nd" ∉ keys(network)
        # prepare the network
        prepare_model!(network)
        # check the presence of nondispatchable generators category
        @test "gen_nd" in keys(network)
        @test length(network["gen_nd"]) == 0
        # check the presence of the lines' susceptance
        for line in values(network["branch"])
            @test "br_b" in keys(line)
        end
        # check the presence of the generators' exprected production and max ramp rate
        for gen in values(network["gen"])
            @test "pexp" in keys(gen)
            @test "max_ramp_rate" in keys(gen)
        end
    end

    @testset "split_nondispatchable" begin
        # import the Swiss model
        network = import_model("switzerland.json")
        @test isa(network, Dict)
        # verify the presence of generators
        @test "gen" in keys(network)
        @test "gen_nd" in keys(network)
        gens = network["gen"]
        @test isa(gens, Dict)
        n_gens = length(network["gen"])
        @test n_gens > 0
        @test length(network["gen_nd"]) == 0
        # separate nuclear generators from the rest
        split_nondispatchable!(network, ["908", "917", "921", "943"])
        @test length(network["gen"]) == n_gens - 4
        @test isa(network["gen_nd"], Dict)
        @test length(network["gen_nd"]) == 4
    end

    @testset "get_ordered_ids" begin
        # import MatPower test case
        network = parse_file("case3.m")
        @test isa(network, Dict)
        # get IDS
        @test get_ordered_gen_ids(network) == ["1", "2", "3"]
        @test get_ordered_bus_ids(network) == ["1", "2", "3"]
        @test get_ordered_line_ids(network) == ["1", "2", "3"]
        @test get_ordered_load_ids(network) == ["1", "2", "3"]
    end

    @testset "get_optimzer" begin
        optimizer = get_optimizer()
        @test isa(optimizer, Ipopt.Optimizer)
        silent_optimizer = get_silent_optimizer()
        @test isa(silent_optimizer, Ipopt.Optimizer)
    end

    @testset "check_balance" begin
        # import MatPower test case
        network = parse_file("case3.m")
        prepare_model!(network)
        # create a random time series for the loads and generation costs
        T = 4
        loads = 0.9 .+ 0.2 * rand(Float64, (3,T)) # random numbers between 0.9 and 1.1
        # verify that the power balance is not respected
        @test !check_balance(network, loads)
        # adjust expected production to match the loads
        balance_model!(network, loads)
        # verify that the power balance is respected
        @test check_balance(network, loads)
    end

    @testset "setup" begin
        # clear data directory
        dir = "data"
        if isdir(dir)
            rm(dir, recursive=true)
        end
        # import MatPower test case
        network = parse_file("case3.m")
        prepare_model!(network)
        # create a random time series for the loads and generation costs
        T = 24
        loads = 0.9 .+ 0.2 * rand(Float64, (3,T)) # random numbers between 0.9 and 1.1
        gen_costs = -1.0 .+ 2.0 * rand(Float64, (3,T)) # random numbers between -1 and 1
        # adjust expected production to match the loads
        balance_model!(network, loads)
        # setup the computation
        setup(dir, network, loads, gen_costs)
        # verify the presence of all the relevant files
        setup_files = ["A_gen.h5", "A_load.h5", "gen_ids.h5", "linear_gen_cost.h5",
            "linear_line_cost.h5", "P_exp.h5", "P_load.h5", "P_max.h5", "PTDF_matrix.h5",
            "P_total.h5", "quadratic_cost.h5", "susceptance.h5", "thermal_limits.h5"]
        @test issetequal(readdir(dir), setup_files)
        # add ramp constraints to one generator and re-setup the computation
        network["gen"]["1"]["max_ramp_rate"] = 1.0
        setup(dir, network, loads, gen_costs, overwrite=true)
        # verify the presence of all the relevant files
        setup_files = vcat(setup_files, ["A_ramp.h5", "ramp_max.h5"])
        @test issetequal(readdir(dir), setup_files)
        # setup another computation with one non-dispatchable generator
        split_nondispatchable!(network, ["2"])
        gen_costs = -1.0 .+ 2.0 * rand(Float64, (2,T)) # random numbers between -1 and 1
        gen_series = 0.9 .+ 0.2 * rand(Float64, (1,T)) # random numbers between 0.9 and 1.1
        balance_model!(network, loads, gen_series)
        setup(dir, network, loads, gen_costs, gen_series, overwrite=true)
        # verify the presence of all the relevant files
        setup_files = vcat(setup_files, ["A_nondispatch.h5", "P_nondispatch.h5"])
        @test issetequal(readdir(dir), setup_files)
        # cleanup
        rm(dir, recursive=true)
    end


    @testset "compute" begin
        # clear data directory
        dir = "data"
        if isdir(dir)
            rm(dir, recursive=true)
        end
        # import MatPower test case
        network = parse_file("case3.m")
        prepare_model!(network)
        # create a random time series for the loads and generation costs
        T = 4
        loads = 0.9 .+ 0.2 * rand(Float64, (3,T)) # random numbers between 0.9 and 1.1
        gen_costs = -1.0 .+ 2.0 * rand(Float64, (3,T)) # random numbers between -1 and 1
        # adjust expected production to match the loads
        balance_model!(network, loads)
        # setup
        setup(dir, network, loads, gen_costs)
        # compute
        compute(dir)
        # verify the presence of the result file
        @test isfile("$dir/P_result.h5")
        # retrieve gen results and verify their validity
        gens = retrieve_gen_results(dir)
        @test size(gens) == (3, T)
        @test all(gens .>= 0)
        gen_ids = get_ordered_gen_ids(network)
        gen_pmax = [network["gen"][id]["pmax"] for id in gen_ids]
        @test all(gens .<= gen_pmax)
        # verify the energy balance at every bus
        injections = retrieve_injections(dir)
        @test all(abs.(sum(injections, dims = 1)) .<= 1e-6)
        # retrieve line results and verify their validity
        flows = retrieve_line_flows(dir)
        @test size(flows) == (3, T)
        flows = retrieve_line_flows(dir, absolute = true)
        @test size(flows) == (3, T)
        @test all(flows .>= 0)
        flows = retrieve_line_flows(dir, absolute = true, relative = true)
        @test size(flows) == (3, T)
        @test all(flows .>= 0)
        @test all(flows .<= 5)
        angles = retrieve_line_angles(dir, absolute = true)
        @test size(angles) == (3, T)
        @test all(angles .>= 0)
        @test all(angles .<= 1.57) # pi / 2
        # cleanup
        rm(dir, recursive=true)
    end

end
